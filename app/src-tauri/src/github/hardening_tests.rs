//! Real native regression gates. Git is required: absence fails, not a silent pass.
//! All repositories and profiles are disposable. No GitHub requests or credentials.
use super::coordinator::GitHubCoordinator;
use super::exec::{resolve_tool, CancelToken, Tool};
use super::git::{CommitOutcome, GitService, PushOutcome};
use super::operations::{OperationJournal, OperationState};
use super::plan::{build_plan, now_secs, ExpectedState, PlanAction, PlanStore};
use super::snapshot;
use crate::settings::{load_or_create_settings, save_settings, AccessMode, AppPaths};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("st-hardening-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn child(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("Git is required for native acceptance");
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}
fn service() -> GitService {
    GitService::new(resolve_tool(Tool::Git).expect("Git is required for native acceptance"))
}
fn repo(root: &Path) {
    git(root, &["init", "--initial-branch=main"]);
    git(root, &["config", "user.name", "Fixture"]);
    git(root, &["config", "user.email", "fixture@example.invalid"]);
    git(root, &["config", "core.autocrlf", "false"]);
    fs::write(root.join("notes.txt"), "initial\n").unwrap();
    git(root, &["add", "--", "notes.txt"]);
    git(
        root,
        &[
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "initial",
        ],
    );
}
fn coordinator(root: &Path, profile: &Path) -> GitHubCoordinator {
    let paths = AppPaths {
        config_dir: profile.to_path_buf(),
        settings_path: profile.join("settings.json"),
        managed_config_path: profile.join("gpt-repo-mcp.config.json"),
        diagnostics_path: profile.join("diagnostics.log"),
    };
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.workspace_path = Some(root.to_string_lossy().into_owned());
    settings.github.enabled = true;
    settings.access_mode = AccessMode::ReadWrite;
    save_settings(&paths, &settings).unwrap();
    let coordinator = GitHubCoordinator::new(paths);
    coordinator
        .bind("fixture", "repository", Some("main".to_string()))
        .unwrap();
    coordinator
}
fn expected() -> ExpectedState {
    ExpectedState {
        workspace_fingerprint: "fixture".to_string(),
        settings_revision: 1,
        local_head: None,
        branch: Some("main".to_string()),
        remote_tip: None,
        content_digest: None,
        publication: None,
        account_login: None,
    }
}
fn id() -> String {
    format!("plan-{}", uuid::Uuid::new_v4().simple())
}

#[test]
fn hardening_atomic_claim_has_exactly_one_winner() {
    let store = PlanStore::new();
    let plan = store
        .insert(build_plan(
            PlanAction::Commit,
            "fixture/repository".to_string(),
            expected(),
            vec!["notes.txt".to_string()],
            Some("fixture".to_string()),
            Vec::new(),
        ))
        .unwrap();
    store.approve(&plan.id, now_secs()).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let id = plan.id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .claim(&id, crate::settings::ApprovalMode::Local)
                    .is_ok()
            })
        })
        .collect();
    barrier.wait();
    assert_eq!(
        workers
            .into_iter()
            .map(|w| usize::from(w.join().unwrap()))
            .sum::<usize>(),
        1
    );
}

#[test]
fn hardening_journal_survives_restart_without_replay() {
    let scratch = Scratch::new();
    let operation = id();
    let first = OperationJournal::new(&scratch.0, "a".repeat(32));
    first.begin(&operation, PlanAction::Push).unwrap();
    assert!(first.begin(&operation, PlanAction::Push).is_err());
    let restarted = OperationJournal::new(&scratch.0, "b".repeat(32));
    let receipt = restarted.get(&operation).unwrap().unwrap();
    assert_eq!(receipt.state, OperationState::Unknown);
    assert!(restarted.begin(&operation, PlanAction::Push).is_err());
}

#[test]
fn hardening_incomplete_journal_tail_is_not_success() {
    use std::io::Write;
    let scratch = Scratch::new();
    let operation = id();
    let journal = OperationJournal::new(&scratch.0, "a".repeat(32));
    let mut receipt = journal.begin(&operation, PlanAction::Commit).unwrap();
    receipt.state = OperationState::Succeeded;
    journal.save(&mut receipt).unwrap();
    let path = scratch
        .0
        .join("github-operations-v1")
        .join(format!("{operation}.jsonl"));
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"{\"incomplete\"")
        .unwrap();
    assert_eq!(
        journal.get(&operation).unwrap().unwrap().state,
        OperationState::Unknown
    );
}

#[test]
fn hardening_captured_bytes_not_later_worktree_bytes_are_committed() {
    let scratch = Scratch::new();
    let root = scratch.child("repo");
    repo(&root);
    let service = service();
    let cancel = CancelToken::new();
    let before = git(&root, &["rev-parse", "HEAD"]);
    fs::write(root.join("notes.txt"), "reviewed\n").unwrap();
    let reviewed = snapshot::capture(&root, &["notes.txt".to_string()]).unwrap();
    fs::write(root.join("notes.txt"), "changed after capture\n").unwrap();
    let committed = service
        .commit_snapshot(&root, &reviewed, Some(&before), "main", "reviewed", &cancel)
        .unwrap();
    assert_ne!(committed.after_head, before);
    assert_eq!(git(&root, &["show", "HEAD:notes.txt"]), "reviewed");
    assert_eq!(
        fs::read_to_string(root.join("notes.txt")).unwrap(),
        "changed after capture\n"
    );
    assert!(!git(&root, &["status", "--porcelain"]).is_empty());
}

#[test]
fn hardening_branch_mismatch_is_refused_before_push() {
    let scratch = Scratch::new();
    let root = scratch.child("repo");
    repo(&root);
    git(&root, &["checkout", "-b", "feature"]);
    let error = service()
        .push(&root, "origin", "main", None, &CancelToken::new())
        .unwrap_err();
    assert_eq!(error.code, "publication_branch_mismatch");
}

#[test]
fn hardening_binding_does_not_authorize_another_origin() {
    let scratch = Scratch::new();
    let root = scratch.child("repo");
    repo(&root);
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/other/repository.git",
        ],
    );
    let error = service()
        .publication_target(&root, "fixture", "repository", "main", &CancelToken::new())
        .unwrap_err();
    assert_eq!(error.code, "publication_repository_mismatch");
}

#[test]
fn hardening_multiple_push_urls_are_refused() {
    let scratch = Scratch::new();
    let root = scratch.child("repo");
    repo(&root);
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/repository.git",
        ],
    );
    git(
        &root,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            "https://github.com/fixture/repository.git",
        ],
    );
    git(
        &root,
        &[
            "config",
            "--add",
            "remote.origin.pushurl",
            "https://github.com/other/repository.git",
        ],
    );
    let error = service()
        .publication_target(&root, "fixture", "repository", "main", &CancelToken::new())
        .unwrap_err();
    assert_eq!(error.code, "ambiguous_push_target");
}

#[test]
fn hardening_repeated_apply_returns_receipt_without_second_commit() {
    let scratch = Scratch::new();
    let root = scratch.child("repo");
    repo(&root);
    let coordinator = coordinator(&root, &scratch.child("profile"));
    fs::write(root.join("notes.txt"), "once\n").unwrap();
    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["notes.txt".to_string()],
            Some("once".to_string()),
        )
        .unwrap();
    coordinator.approve(&plan.id).unwrap();
    let first = coordinator.apply(&plan.id).unwrap();
    assert_eq!(first.state, OperationState::Succeeded);
    let second = coordinator.apply(&plan.id).unwrap();
    assert_eq!(second.operation_id, first.operation_id);
    assert_eq!(
        second.commit.unwrap().after_head,
        first.commit.unwrap().after_head
    );
    assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "2");
}

#[test]
fn hardening_paths_reject_sensitive_files_and_pathspecs_in_native_layer() {
    for path in [
        ".git/config",
        ".env.local",
        "dir/*.txt",
        "../escape",
        "a//b",
        "a/./b",
        " cert.key",
        "cert.key",
    ] {
        assert!(snapshot::validate_path(path).is_err(), "must refuse {path}");
    }
}

#[cfg(unix)]
#[test]
fn hardening_symlink_parent_is_never_followed() {
    let scratch = Scratch::new();
    let root = scratch.child("repo");
    let outside = scratch.child("outside");
    fs::write(outside.join("file.txt"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
    assert!(snapshot::capture(&root, &["linked/file.txt".to_string()]).is_err());
}

#[test]
fn hardening_emit_real_rust_wire_fixture() {
    let scratch = Scratch::new();
    let journal = OperationJournal::new(&scratch.0, "a".repeat(32));
    let mut receipt = journal
        .begin(&format!("plan-{}", "b".repeat(32)), PlanAction::CommitPush)
        .unwrap();
    receipt.state = OperationState::Succeeded;
    receipt.phase = "complete".to_string();
    let mut bound = expected();
    bound.local_head = Some("c".repeat(40));
    bound.publication = Some(super::publication::PublicationTarget {
        remote: "origin".to_string(),
        url: "https://github.com/fixture/repository.git".to_string(),
        repository: "fixture/repository".to_string(),
        branch: "main".to_string(),
    });
    receipt.expected = Some(bound);
    receipt.commit = Some(CommitOutcome {
        before_head: Some("c".repeat(40)),
        after_head: "d".repeat(40),
        committed_paths: vec!["notes.txt".to_string()],
        pushed: Some(PushOutcome {
            remote: "origin".to_string(),
            branch: "main".to_string(),
            pushed_head: "d".repeat(40),
            verified_remote_head: Some("d".repeat(40)),
            repository: Some("fixture/repository".to_string()),
        }),
    });
    journal.save(&mut receipt).unwrap();
    let encoded = serde_json::to_value(&receipt).unwrap();
    assert_eq!(encoded["schemaVersion"], 1);
    assert_eq!(
        encoded["commit"]["pushed"]["verifiedRemoteHead"],
        "d".repeat(40)
    );
    // The release verifier supplies a disposable output path. Absence does not
    // fabricate cross-language evidence: the Node fixture gate requires this file.
    if let Some(output) = std::env::var_os("SECRET_TUNNEL_CONTRACT_FIXTURE_OUT") {
        let path = PathBuf::from(output);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
}
