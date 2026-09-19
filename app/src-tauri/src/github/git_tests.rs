//! Local Git service tests (TEST_PLAN A05/A10-A13, T06-T08 local portions).
//!
//! These run against real disposable repositories, per the plan's instruction
//! to test local Git semantics without GitHub first. If `git` is not installed
//! the tests skip rather than fail, so the suite stays meaningful on a machine
//! that simply has no Git.

use super::exec::{resolve_tool, CancelToken, Tool};
use super::git::{validate_branch_name, validate_remote_name, GitService};
use std::fs;
use std::path::PathBuf;

fn service() -> Option<GitService> {
    resolve_tool(Tool::Git).ok().map(GitService::new)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "st-git-{}-{}-{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A repository that exists but has no commits is a normal starting point for
/// publishing a new project, so it must be describable rather than an error.
#[test]
fn reports_an_unborn_repository_without_failing() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("unborn");
    git.init(&root, "main", &cancel).unwrap();

    let state = git.state(&root, &cancel).unwrap();
    assert!(state.unborn, "a repository with no commits is unborn");
    assert_eq!(state.head, None);
    assert_eq!(state.branch.as_deref(), Some("main"));
    assert!(state.remotes.is_empty());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn stages_and_commits_exactly_the_reviewed_paths() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("commit");
    git.init(&root, "main", &cancel).unwrap();

    fs::write(root.join("wanted.txt"), "keep\n").unwrap();
    fs::write(root.join("unrelated.txt"), "should not be committed\n").unwrap();

    git.stage_exact(&root, &["wanted.txt".to_string()], &cancel)
        .unwrap();

    let staged = git.staged_paths(&root, &cancel).unwrap();
    assert_eq!(staged, vec!["wanted.txt".to_string()]);

    let outcome = git
        .commit(
            &root,
            "add wanted file",
            Some(("Secret Tunnel Test", "test@example.invalid")),
            &cancel,
        )
        .unwrap();

    assert_eq!(outcome.before_head, None, "first commit has no parent");
    assert!(!outcome.after_head.is_empty());
    assert_eq!(outcome.committed_paths, vec!["wanted.txt".to_string()]);

    // The unrelated file must still be sitting there untracked.
    let state = git.state(&root, &cancel).unwrap();
    assert!(state.untracked_paths.contains(&"unrelated.txt".to_string()));
    assert!(!state.unborn);

    let _ = fs::remove_dir_all(&root);
}

/// Committing with nothing staged must be refused rather than producing an
/// empty commit or sweeping up whatever happens to be in the tree.
#[test]
fn refuses_to_commit_with_nothing_staged() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("nothing");
    git.init(&root, "main", &cancel).unwrap();
    fs::write(root.join("loose.txt"), "not staged\n").unwrap();

    let error = git
        .commit(&root, "should not happen", None, &cancel)
        .unwrap_err();
    assert_eq!(error.code, "git_nothing_staged");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn refuses_an_empty_commit_message() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("message");
    git.init(&root, "main", &cancel).unwrap();
    fs::write(root.join("a.txt"), "a\n").unwrap();
    git.stage_exact(&root, &["a.txt".to_string()], &cancel)
        .unwrap();

    let error = git.commit(&root, "   ", None, &cancel).unwrap_err();
    assert_eq!(error.code, "git_empty_message");

    let _ = fs::remove_dir_all(&root);
}

/// A commit message is one argv entry, so punctuation that would be syntax in
/// a shell is just text in the message.
#[test]
fn commit_message_with_shell_metacharacters_is_stored_literally() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("meta");
    git.init(&root, "main", &cancel).unwrap();
    fs::write(root.join("a.txt"), "a\n").unwrap();
    git.stage_exact(&root, &["a.txt".to_string()], &cancel)
        .unwrap();

    let message = "fix: handle $(whoami) && `id` | tee \"x\"; rm -rf .";
    git.commit(
        &root,
        message,
        Some(("Secret Tunnel Test", "test@example.invalid")),
        &cancel,
    )
    .unwrap();

    // The repository must still contain the file: nothing was executed.
    assert!(root.join("a.txt").exists());
    let state = git.state(&root, &cancel).unwrap();
    assert!(!state.unborn);

    let _ = fs::remove_dir_all(&root);
}

/// `git rev-parse` walks upwards, so a folder inside someone else's repository
/// reports that parent as its root. Binding must notice rather than silently
/// adopt the outer repository.
#[test]
fn distinguishes_a_repository_root_from_a_subdirectory() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("nested");
    git.init(&root, "main", &cancel).unwrap();
    let nested = root.join("sub").join("deeper");
    fs::create_dir_all(&nested).unwrap();

    assert!(git.is_repository_root(&root, &cancel));
    assert!(
        !git.is_repository_root(&nested, &cancel),
        "a subdirectory must not be treated as its own repository root"
    );

    let discovered = git.discover_root(&nested, &cancel).unwrap();
    assert!(
        discovered.to_string_lossy().to_lowercase() == root.to_string_lossy().to_lowercase()
            || fs::canonicalize(&discovered).ok() == fs::canonicalize(&root).ok(),
        "discovery should report the outer root: {discovered:?} vs {root:?}"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn reports_a_folder_that_is_not_a_repository() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let plain = scratch("plain");

    assert!(!git.is_repository_root(&plain, &cancel));

    let _ = fs::remove_dir_all(&plain);
}

#[test]
fn reads_remotes() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("remotes");
    git.init(&root, "main", &cancel).unwrap();

    assert!(git.remotes(&root, &cancel).unwrap().is_empty());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn branch_names_are_validated() {
    for good in ["main", "release/1.0", "feature_x", "fix-123"] {
        assert!(validate_branch_name(good).is_ok(), "{good} should be valid");
    }
    // Leading dash would be read as an option; the rest are refused by Git
    // itself or are ambiguous in a revision expression.
    for bad in [
        "",
        "-delete",
        "/leading",
        "trailing/",
        "ends.",
        "has..dots",
        "has space",
        "has~tilde",
        "has^caret",
        "has:colon",
        "has?question",
        "has*star",
        "has[bracket",
        "has\\backslash",
        "ends.lock",
    ] {
        assert!(
            validate_branch_name(bad).is_err(),
            "{bad:?} should be rejected"
        );
    }
}

/// A remote name is passed to git in argv, so anything that could be read as an
/// option or as a URL must be refused rather than reaching the command line.
#[test]
fn remote_names_reject_options_urls_and_paths() {
    for good in ["origin", "upstream", "my-remote", "remote_2", "fork.a"] {
        assert!(
            validate_remote_name(good).is_ok(),
            "{good:?} should be accepted"
        );
    }
    for bad in [
        "",
        "-upstream",
        "--upload-pack=evil",
        "https://example.invalid/repo.git",
        "git@github.com:owner/repo",
        "origin/main",
        r"..\other",
        "a b",
        "naughty;rm",
    ] {
        assert!(
            validate_remote_name(bad).is_err(),
            "{bad:?} should be rejected"
        );
    }
    assert!(validate_remote_name(&"a".repeat(101)).is_err());
}

/// Proves push actually moves a ref, rather than only that its arguments
/// validate. The remote is a local bare repository, so this exercises the real
/// `git push` path with no network, no credentials and no GitHub account.
#[test]
fn push_moves_a_commit_to_a_real_remote() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();

    let bare = scratch("push-remote");
    assert!(std::process::Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&bare)
        .status()
        .map(|status| status.success())
        .unwrap_or(false));

    let root = scratch("push-source");
    git.init(&root, "main", &cancel).unwrap();
    fs::write(root.join("notes.md"), "fixture\n").unwrap();
    git.stage_exact(&root, &["notes.md".to_string()], &cancel)
        .unwrap();
    let committed = git
        .commit(
            &root,
            "Fixture commit",
            Some(("Fixture", "fixture@example.invalid")),
            &cancel,
        )
        .unwrap();
    assert!(committed.pushed.is_none(), "a commit alone must not push");

    assert!(std::process::Command::new("git")
        .current_dir(&root)
        .args(["remote", "add", "origin"])
        .arg(&bare)
        .status()
        .map(|status| status.success())
        .unwrap_or(false));

    let pushed = git.push(&root, "origin", "main", None, &cancel).unwrap();
    assert_eq!(pushed.remote, "origin");
    assert_eq!(pushed.branch, "main");
    assert_eq!(pushed.pushed_head, committed.after_head);

    // The ref really exists on the remote now, with the commit we made.
    let observed = std::process::Command::new("git")
        .current_dir(&bare)
        .args(["rev-parse", "refs/heads/main"])
        .output()
        .unwrap();
    assert!(observed.status.success(), "the remote must now have main");
    assert_eq!(
        String::from_utf8_lossy(&observed.stdout).trim(),
        committed.after_head,
        "the remote branch must point at the commit that was pushed"
    );

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&bare);
}

/// Pointing a repository at a remote must work whether or not one already
/// exists, and must refuse a URL that is not a GitHub https address.
#[test]
fn set_remote_adds_then_updates_and_refuses_foreign_urls() {
    let Some(git) = service() else { return };
    let cancel = CancelToken::new();
    let root = scratch("set-remote");
    git.init(&root, "main", &cancel).unwrap();

    assert!(git.remotes(&root, &cancel).unwrap().is_empty());

    git.set_remote(
        &root,
        "origin",
        "https://github.com/owner/first.git",
        &cancel,
    )
    .unwrap();
    let added = git.remotes(&root, &cancel).unwrap();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].name, "origin");
    assert!(added[0].url.contains("first"));

    // Calling it again must update the existing remote, not fail or duplicate.
    git.set_remote(
        &root,
        "origin",
        "https://github.com/owner/second.git",
        &cancel,
    )
    .unwrap();
    let updated = git.remotes(&root, &cancel).unwrap();
    assert_eq!(updated.len(), 1, "origin must not be duplicated");
    assert!(updated[0].url.contains("second"));

    for bad in [
        "http://github.com/owner/repo.git",
        "https://example.invalid/owner/repo.git",
        "git@github.com:owner/repo.git",
        "--upload-pack=evil",
    ] {
        assert!(
            git.set_remote(&root, "origin", bad, &cancel).is_err(),
            "{bad:?} should be rejected"
        );
    }

    let _ = fs::remove_dir_all(&root);
}

/// The managed push must authenticate with the token the user granted this
/// app, not with whatever the machine's credential manager happens to hold.
///
/// Asks Git the same question the push path does, with an unrelated credential
/// already installed, and checks which answer comes back. If the empty helper
/// ever stops clearing the inherited chain, this returns the machine's
/// credential and fails.
#[test]
fn the_connected_token_answers_git_instead_of_the_machine_credential_manager() {
    let Ok(tool) = resolve_tool(Tool::Git) else {
        return;
    };
    let service = GitService::new(tool);
    let root = std::env::temp_dir();
    let outcome = crate::github::exec::run(
        service
            .spec_with_credential(&root, Some("fixture-token-not-real"))
            .arg("credential")
            .arg("fill")
            .input(
                b"protocol=https
host=github.com

"
                .to_vec(),
            ),
        &CancelToken::new(),
    )
    .unwrap();

    assert!(outcome.success(), "git credential fill should answer");
    // Our helper answered, and answered first: the machine's credential
    // manager would have returned its own login, not this username.
    assert!(outcome
        .stdout
        .lines()
        .any(|line| line == "username=x-access-token"));
    // And the token itself is masked even in internally captured output, so
    // the credential exists on the wire to Git and nowhere else.
    assert!(
        !outcome.stdout.contains("fixture-token-not-real"),
        "the credential must never survive into captured output"
    );
    assert!(outcome
        .stdout
        .lines()
        .any(|line| line.starts_with("password=") && line != "password="));
}
