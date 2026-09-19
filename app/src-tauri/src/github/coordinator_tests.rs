//! T20 - the content digest that binds an approval to actual bytes.
//!
//! The digest is the difference between approving a *filename* and approving a
//! *change*. These tests hold it to that: identical bytes must agree, and every
//! way the bytes could differ must disagree.

use super::coordinator::{content_digest, rebind_precondition, GitHubCoordinator};
use crate::settings::{load_or_create_settings, save_settings, AccessMode, AppPaths};
use std::fs;
use std::path::PathBuf;

/// A private directory per test. Tests in this crate share a temp root, so a
/// shared name would let one test delete another's fixtures mid-run.
fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "secret-tunnel-digest-test-{}-{}",
        std::process::id(),
        name
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn digest(root: &PathBuf, paths: &[&str]) -> String {
    content_digest(
        root,
        &paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
    )
    .unwrap()
}

/// The same bytes must always produce the same digest, or every apply would be
/// refused and the feature would be useless.
#[test]
fn t20_identical_content_digests_identically() {
    let root = scratch("stable");
    fs::write(root.join("a.txt"), b"hello").unwrap();
    assert_eq!(digest(&root, &["a.txt"]), digest(&root, &["a.txt"]));
}

/// The case the binding exists for: the file is edited after the plan is made.
#[test]
fn t20_editing_a_file_changes_the_digest() {
    let root = scratch("edited");
    fs::write(root.join("a.txt"), b"reviewed content").unwrap();
    let before = digest(&root, &["a.txt"]);
    fs::write(root.join("a.txt"), b"substituted content").unwrap();
    assert_ne!(
        before,
        digest(&root, &["a.txt"]),
        "rewriting a planned file must invalidate the plan"
    );
}

/// A single byte is enough. A digest that only noticed large edits would be a
/// digest an attacker could work within.
#[test]
fn t20_a_one_byte_change_changes_the_digest() {
    let root = scratch("onebyte");
    fs::write(root.join("a.txt"), b"transfer 100 to alice").unwrap();
    let before = digest(&root, &["a.txt"]);
    fs::write(root.join("a.txt"), b"transfer 900 to alice").unwrap();
    assert_ne!(before, digest(&root, &["a.txt"]));
}

/// "Absent" and "empty" are different states, and a planned deletion is real
/// work. Hashing them alike would let a file be restored, or removed, between
/// review and apply without the digest noticing.
#[test]
fn t20_a_missing_file_differs_from_an_empty_one() {
    let root = scratch("absent");
    let missing = digest(&root, &["gone.txt"]);
    fs::write(root.join("gone.txt"), b"").unwrap();
    assert_ne!(missing, digest(&root, &["gone.txt"]));
}

/// Deleting a reviewed file after approval must not slip through.
#[test]
fn t20_deleting_a_file_changes_the_digest() {
    let root = scratch("deleted");
    fs::write(root.join("a.txt"), b"content").unwrap();
    let before = digest(&root, &["a.txt"]);
    fs::remove_file(root.join("a.txt")).unwrap();
    assert_ne!(before, digest(&root, &["a.txt"]));
}

/// Path and content are hashed together and terminated, so content cannot be
/// shifted across a path boundary to forge a matching digest.
#[test]
fn t20_moving_content_between_paths_changes_the_digest() {
    let root = scratch("boundary");
    fs::write(root.join("a.txt"), b"one").unwrap();
    fs::write(root.join("b.txt"), b"twothree").unwrap();
    let before = digest(&root, &["a.txt", "b.txt"]);

    fs::write(root.join("a.txt"), b"onetwo").unwrap();
    fs::write(root.join("b.txt"), b"three").unwrap();
    assert_ne!(
        before,
        digest(&root, &["a.txt", "b.txt"]),
        "concatenation must not be ambiguous across path boundaries"
    );
}

/// Each planned path contributes. A digest that ignored later entries would let
/// a multi-file plan be tampered with in all but its first file.
#[test]
fn t20_every_planned_path_contributes() {
    let root = scratch("multi");
    fs::write(root.join("a.txt"), b"first").unwrap();
    fs::write(root.join("b.txt"), b"second").unwrap();
    let before = digest(&root, &["a.txt", "b.txt"]);
    fs::write(root.join("b.txt"), b"tampered").unwrap();
    assert_ne!(before, digest(&root, &["a.txt", "b.txt"]));
}

/// `git add -- some/dir` stages whatever happens to be inside it at the time,
/// which is precisely the open-ended set the digest exists to rule out. A plan
/// has to name its files, so a folder is refused rather than silently accepted.
#[test]
fn t20_a_directory_path_is_refused() {
    let root = scratch("directory");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src").join("a.txt"), b"inside").unwrap();
    let error = content_digest(&root, &["src".to_string()])
        .expect_err("a folder must not be accepted as a planned path");
    assert_eq!(error.code, "path_is_directory");
}

/// A large file must be digested by streaming rather than refused or truncated:
/// truncating would leave the tail of a big file unbound.
#[test]
fn t20_a_file_larger_than_the_read_buffer_is_fully_digested() {
    let root = scratch("large");
    let mut content = vec![b'x'; 200 * 1024];
    fs::write(root.join("big.bin"), &content).unwrap();
    let before = digest(&root, &["big.bin"]);

    // Change the final byte only - past every 64 KiB buffer boundary.
    *content.last_mut().unwrap() = b'y';
    fs::write(root.join("big.bin"), &content).unwrap();
    assert_ne!(
        before,
        digest(&root, &["big.bin"]),
        "a change in the tail of a large file must still be seen"
    );
}

fn config_paths(name: &str) -> AppPaths {
    let root = std::env::temp_dir().join(format!(
        "secret-tunnel-github-coord-{}-{}",
        std::process::id(),
        name
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    AppPaths {
        config_dir: root.clone(),
        settings_path: root.join("settings.json"),
        managed_config_path: root.join("gpt-repo-mcp.config.json"),
        diagnostics_path: root.join("diagnostics.log"),
    }
}

/// The same paths without the wipe, for a test that has already built a
/// fixture with `config_paths` and now wants to read or edit it.
fn existing_config_paths(name: &str) -> AppPaths {
    let root = std::env::temp_dir().join(format!(
        "secret-tunnel-github-coord-{}-{}",
        std::process::id(),
        name
    ));
    AppPaths {
        config_dir: root.clone(),
        settings_path: root.join("settings.json"),
        managed_config_path: root.join("gpt-repo-mcp.config.json"),
        diagnostics_path: root.join("diagnostics.log"),
    }
}

/// Read mode must be refused by the coordinator, not only by which tools the
/// MCP child chooses to advertise.
///
/// That child decides its own surface by reading its own environment, so it is
/// on the far side of the trust boundary: a replaced or misconfigured one could
/// still reach the broker. This is the check that does not depend on it.
#[test]
fn t20_read_mode_refuses_to_create_a_plan() {
    let paths = config_paths("read-mode");
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.github.enabled = true;
    settings.access_mode = AccessMode::Read;
    save_settings(&paths, &settings).unwrap();

    let coordinator = GitHubCoordinator::new(paths);
    let error = coordinator
        .create_plan(
            super::plan::PlanAction::Commit,
            vec!["a.txt".to_string()],
            Some("a message".to_string()),
        )
        .expect_err("read mode must refuse to plan a mutation");
    assert_eq!(error.code, "read_only_mode");
}

/// The refusal must be reported, not silent, so the panel can say why the
/// feature is doing nothing.
#[test]
fn t20_read_mode_is_reported_as_a_blocked_reason() {
    let paths = config_paths("read-mode-status");
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.github.enabled = true;
    settings.access_mode = AccessMode::Read;
    save_settings(&paths, &settings).unwrap();

    let coordinator = GitHubCoordinator::new(paths);
    let status = coordinator.status().unwrap();
    let reason = status.blocked_reason.expect("read mode must be explained");
    assert!(
        reason.contains("Read"),
        "the reason should name the setting to change, got: {reason}"
    );
}

// --- End-to-end, against a real repository -------------------------------
//
// The unit tests above prove each guard in isolation. These drive the whole
// chain the way the app does - bind, plan, approve, apply - because the
// guarantee being claimed is a property of the sequence, not of any one check.

use super::exec::{resolve_tool, CancelToken, Tool};
use super::git::GitService;
use super::plan::PlanAction;

/// A coordinator whose workspace is a real repository with one commit.
/// Returns `None` when git is unavailable, so the suite stays meaningful on a
/// machine that simply has no Git, matching git_tests.rs.
fn live_repo(name: &str) -> Option<(GitHubCoordinator, PathBuf, GitService)> {
    let git = GitService::new(resolve_tool(Tool::Git).ok()?);
    let cancel = CancelToken::new();

    let root = scratch(name).join("repo");
    fs::create_dir_all(&root).unwrap();
    git.init(&root, "main", &cancel).unwrap();
    for (key, value) in [
        ("user.name", "Secret Tunnel Fixture"),
        ("user.email", "fixture@example.invalid"),
    ] {
        assert!(std::process::Command::new("git")
            .current_dir(&root)
            .args(["config", key, value])
            .status()
            .unwrap()
            .success());
    }
    fs::write(root.join("note.txt"), "reviewed content\n").unwrap();
    git.stage_exact(&root, &["note.txt".to_string()], &cancel)
        .unwrap();
    git.commit(
        &root,
        "initial",
        Some(("Test", "test@example.invalid")),
        &cancel,
    )
    .unwrap();

    let paths = config_paths(name);
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.workspace_path = Some(root.to_string_lossy().into_owned());
    settings.access_mode = AccessMode::ReadWrite;
    settings.github.enabled = true;
    save_settings(&paths, &settings).unwrap();

    let coordinator = GitHubCoordinator::new(paths);
    coordinator.bind("octocat", "hello-world", None).unwrap();
    Some((coordinator, root, git))
}

/// The ordinary path has to work, or the guarantees below are guarantees about
/// a feature that never does anything.
#[test]
fn t20_end_to_end_a_reviewed_change_is_committed() {
    let Some((coordinator, root, git)) = live_repo("e2e-commit") else {
        return;
    };
    let cancel = CancelToken::new();
    fs::write(root.join("note.txt"), "a change ChatGPT proposed\n").unwrap();

    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("apply the reviewed change".to_string()),
        )
        .unwrap();
    coordinator.approve(&plan.id).unwrap();
    coordinator
        .apply(&plan.id)
        .expect("an approved, unchanged plan applies");

    let state = git.state(&root, &cancel).unwrap();
    assert!(
        state.staged_paths.is_empty(),
        "no reviewed file should remain staged"
    );
    assert!(
        state.unstaged_paths.is_empty(),
        "the reviewed change should now be committed"
    );
    // The shared Actions interlock may introduce its untracked controller file.
    // It is never swept into the reviewed commit.
    assert!(state
        .untracked_paths
        .iter()
        .all(|path| path == ".chatgpt/" || path == ".chatgpt/actions/controller.lock"));
}

/// The property the whole module exists for, exercised end to end on a real
/// repository: the bytes are replaced after approval and before apply, while
/// HEAD, branch, settings and folder all stay exactly as they were.
///
/// Without the content binding this commits the substituted text under the
/// approved message, and the user has authorised something they never saw.
#[test]
fn t20_end_to_end_content_swapped_after_approval_is_refused() {
    let Some((coordinator, root, git)) = live_repo("e2e-toctou") else {
        return;
    };
    let cancel = CancelToken::new();
    let before = git.state(&root, &cancel).unwrap();

    fs::write(root.join("note.txt"), "what the user read\n").unwrap();
    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("apply the reviewed change".to_string()),
        )
        .unwrap();
    coordinator.approve(&plan.id).unwrap();

    // The substitution. Nothing else about the repository moves.
    fs::write(root.join("note.txt"), "what was committed instead\n").unwrap();

    let error = coordinator
        .apply(&plan.id)
        .expect_err("apply must refuse once the reviewed bytes have changed");
    assert_eq!(error.code, "content_changed");

    let after = git.state(&root, &cancel).unwrap();
    assert_eq!(
        before.head, after.head,
        "a refused apply must not create a commit"
    );
}

/// A refusal must leave the repository as it was found. Staging first and
/// checking afterwards would mean a rejected apply still moved the index, so
/// this asserts on the index rather than only on the error.
#[test]
fn t20_end_to_end_a_refused_apply_leaves_the_index_untouched() {
    let Some((coordinator, root, git)) = live_repo("e2e-index") else {
        return;
    };
    let cancel = CancelToken::new();

    fs::write(root.join("note.txt"), "planned change\n").unwrap();
    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("planned".to_string()),
        )
        .unwrap();
    coordinator.approve(&plan.id).unwrap();

    // Something the user never reviewed is staged behind the app's back.
    fs::write(root.join("secret.txt"), "never reviewed\n").unwrap();
    git.stage_exact(&root, &["secret.txt".to_string()], &cancel)
        .unwrap();

    let error = coordinator
        .apply(&plan.id)
        .expect_err("an unreviewed staged path must refuse the apply");
    assert_eq!(error.code, "unreviewed_staged_paths");

    // The planned file must not have been staged by the attempt.
    let staged = git.staged_paths(&root, &cancel).unwrap();
    assert!(
        !staged.contains(&"note.txt".to_string()),
        "a refused apply must not have staged the planned path, got: {staged:?}"
    );
}

/// An applied plan is spent. Replaying the same id must not produce a second
/// commit, whoever replays it.
#[test]
fn t20_end_to_end_a_plan_cannot_be_applied_twice() {
    let Some((coordinator, root, _git)) = live_repo("e2e-replay") else {
        return;
    };
    fs::write(root.join("note.txt"), "once\n").unwrap();

    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("once only".to_string()),
        )
        .unwrap();
    coordinator.approve(&plan.id).unwrap();
    coordinator.apply(&plan.id).unwrap();

    let receipt = coordinator
        .apply(&plan.id)
        .expect("a spent plan returns its durable receipt");
    assert_eq!(receipt.operation_id, plan.id);
    assert_eq!(receipt.state, super::operations::OperationState::Succeeded);
    assert!(receipt.commit.is_some());
}

/// The behaviour the product promises: once the user has connected GitHub,
/// ChatGPT commits without a second desktop click.
///
/// Deliberately calls no `approve`. If this ever needs one again, the
/// connection has stopped being the authorisation and the feature is broken.
#[test]
fn a_connected_installation_commits_without_a_desktop_approval() {
    let Some((coordinator, root, git)) = live_repo("autonomous-commit") else {
        return;
    };
    let cancel = CancelToken::new();
    let paths = existing_config_paths("autonomous-commit");
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.github.approval_mode = crate::settings::ApprovalMode::Autonomous;
    save_settings(&paths, &settings).unwrap();

    fs::write(root.join("note.txt"), "written by ChatGPT\n").unwrap();
    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("ship it".to_string()),
        )
        .unwrap();
    coordinator
        .apply(&plan.id)
        .expect("autonomous mode is the authorisation");

    assert!(git.state(&root, &cancel).unwrap().unstaged_paths.is_empty());

    // And again, so the grant is persistent rather than good for one call.
    fs::write(root.join("note.txt"), "a second change\n").unwrap();
    let second = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("ship it again".to_string()),
        )
        .unwrap();
    coordinator
        .apply(&second.id)
        .expect("the authorisation survives the first operation");
}

/// Autonomous is not reckless: the bytes still have to be the reviewed bytes.
#[test]
fn autonomous_mode_still_refuses_content_that_changed() {
    let Some((coordinator, root, _git)) = live_repo("autonomous-toctou") else {
        return;
    };
    let paths = existing_config_paths("autonomous-toctou");
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.github.approval_mode = crate::settings::ApprovalMode::Autonomous;
    save_settings(&paths, &settings).unwrap();

    fs::write(root.join("note.txt"), "planned bytes\n").unwrap();
    let plan = coordinator
        .create_plan(
            PlanAction::Commit,
            vec!["note.txt".to_string()],
            Some("ship it".to_string()),
        )
        .unwrap();
    fs::write(root.join("note.txt"), "substituted bytes\n").unwrap();
    assert_eq!(
        coordinator.apply(&plan.id).unwrap_err().code,
        "content_changed"
    );
}

/// Disconnect gives back the authorisation it was granted, and nothing else.
#[test]
fn disconnecting_returns_to_local_approval_without_touching_local_state() {
    let Some((coordinator, _root, _git)) = live_repo("disconnect") else {
        return;
    };
    let paths = existing_config_paths("disconnect");
    let mut settings = load_or_create_settings(&paths).unwrap();
    settings.github.approval_mode = crate::settings::ApprovalMode::Autonomous;
    save_settings(&paths, &settings).unwrap();

    coordinator.forget_connection().unwrap();

    let after = load_or_create_settings(&paths).unwrap();
    assert_eq!(
        after.github.approval_mode,
        crate::settings::ApprovalMode::Local
    );
    assert!(!after.github.enabled);
    // The binding is local state about the user's own folder and is not a
    // credential; disconnecting an account must not silently unbind it.
    assert!(after.github.binding.is_some());
}

/// A retarget is only safe when the caller is acting on the binding that is
/// really there. These hold `rebind_precondition` to exactly that, because it
/// is the gate between "deliberately move this folder" and "move this folder
/// somewhere the user never saw".
mod rebind {
    use super::*;
    use crate::settings::RepositoryBinding;

    fn binding(owner: &str, repo: &str) -> RepositoryBinding {
        RepositoryBinding {
            workspace_fingerprint: "fixture-fingerprint".to_string(),
            host: "github.com".to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
            repository_id: Some(1),
            integration_branch: "main".to_string(),
            pages_url: None,
            pages_domain: None,
        }
    }

    /// The ordinary case: the request names the binding that is current and
    /// origin still agrees with it.
    #[test]
    fn the_expected_binding_and_a_matching_origin_may_be_retargeted() {
        rebind_precondition(
            &binding("octocat", "old-repo"),
            "octocat",
            "old-repo",
            Some("https://github.com/octocat/old-repo.git"),
        )
        .expect("the stated binding is the one that is there");
    }

    /// A folder that has never had an origin is still a folder whose binding
    /// the user chose, so the absence of a remote is not an obstacle.
    #[test]
    fn a_workspace_without_an_origin_may_be_retargeted() {
        rebind_precondition(&binding("octocat", "old-repo"), "octocat", "old-repo", None)
            .expect("no origin is nothing to disagree with");
    }

    /// The case this exists for: the request was written against a reading of
    /// the binding that is no longer true. Guessing here would retarget a
    /// folder the user has since pointed somewhere else.
    #[test]
    fn a_stale_expected_binding_is_refused() {
        let error = rebind_precondition(
            &binding("octocat", "actual-repo"),
            "octocat",
            "stale-repo",
            Some("https://github.com/octocat/actual-repo.git"),
        )
        .expect_err("a binding nobody read must not be replaced");
        assert_eq!(error.code, "binding_mismatch");
        assert!(
            error.message.contains("octocat/actual-repo"),
            "the refusal must name what is actually bound: {}",
            error.message
        );
    }

    /// Owner and repository are both part of the identity; matching only the
    /// name would let a fork of the same project be retargeted by accident.
    #[test]
    fn a_different_owner_is_refused() {
        assert_eq!(
            rebind_precondition(
                &binding("octocat", "shared-name"),
                "someone-else",
                "shared-name",
                None,
            )
            .expect_err("owner is part of the identity")
            .code,
            "binding_mismatch"
        );
    }

    /// An origin someone configured by hand outside this app is theirs, not
    /// this app's to overwrite, even when the desktop binding does match.
    #[test]
    fn an_origin_pointing_somewhere_else_is_refused() {
        assert_eq!(
            rebind_precondition(
                &binding("octocat", "old-repo"),
                "octocat",
                "old-repo",
                Some("https://github.com/octocat/something-a-human-set.git"),
            )
            .expect_err("a hand-configured remote is not replaced silently")
            .code,
            "origin_mismatch"
        );
    }
}
