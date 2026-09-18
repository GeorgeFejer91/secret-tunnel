//! Typed local Git operations.
//!
//! Every operation builds its own argv and goes through [`exec`], so no caller
//! can reach a shell or name a program. Inspection comes first and mutation is
//! deliberately narrow: the beta stages exactly the reviewed paths and makes
//! exactly the planned commit.

use super::exec::{self, CancelToken, CommandSpec, ResolvedTool};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where a repository lives and what state it is in right now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryState {
    /// Canonical path of the repository's working tree root.
    pub root: String,
    /// `None` in a repository that has no commits yet.
    pub head: Option<String>,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// True when a repository exists but has no commits.
    pub unborn: bool,
    pub dirty: bool,
    pub staged_paths: Vec<String>,
    pub unstaged_paths: Vec<String>,
    pub untracked_paths: Vec<String>,
    pub remotes: Vec<Remote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// A commit that actually happened, reported with both sides of the change so a
/// receipt can prove exactly what moved.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub before_head: Option<String>,
    pub after_head: String,
    pub committed_paths: Vec<String>,
    /// Present only when the approved plan also pushed. Absent for a plain
    /// local commit, so an existing caller sees exactly what it saw before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pushed: Option<PushOutcome>,
}

/// Result of a push. Carries no credential and no remote URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub remote: String,
    pub branch: String,
    pub pushed_head: String,
    #[serde(default)]
    pub verified_remote_head: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
}

/// Name of the environment entry the credential helper below reads. Git
/// exports the child environment to the helper, so the token travels there
/// rather than through argv or a file.
const CREDENTIAL_ENV: &str = "SECRET_TUNNEL_GIT_CREDENTIAL";

/// A `credential.helper` defined entirely on the command line for one push.
///
/// Git runs a helper whose value begins with `!` as a shell command, using the
/// shell it ships with, and passes the operation as the first argument. Only
/// `get` is answered: `store` and `erase` are ignored, so nothing this app
/// holds is ever written into the machine's credential manager. The username
/// is the conventional placeholder GitHub accepts alongside a token password.
const CREDENTIAL_HELPER: &str = concat!(
    "!f() { test \"$1\" = get || exit 0; ",
    "echo username=x-access-token; ",
    "echo password=$SECRET_TUNNEL_GIT_CREDENTIAL; }; f"
);

pub struct GitService {
    git: ResolvedTool,
    deadline: Duration,
}

impl GitService {
    pub fn new(git: ResolvedTool) -> Self {
        Self {
            git,
            deadline: Duration::from_secs(60),
        }
    }

    pub fn version(&self) -> &str {
        &self.git.version
    }

    pub(super) fn spec(&self, cwd: &Path) -> CommandSpec {
        // `-c core.hooksPath=` disables repository hooks. A hook is a script in
        // the very folder being shared, so honouring one would let content that
        // arrived over the tunnel execute during an otherwise reviewed action.
        CommandSpec::new(self.git.clone(), cwd)
            .arg("-c")
            .arg("core.hooksPath=")
            .arg("--no-pager")
            .arg("--literal-pathspecs")
            .deadline(self.deadline)
    }

    /// `spec`, plus the connected account's token as the only credential
    /// helper Git may consult for this one invocation.
    ///
    /// The empty helper first discards any chain inherited from the machine's
    /// configuration, so the ambient credential manager cannot answer ahead of
    /// ours and a fresh installation behaves the same as a developer's.
    pub(super) fn spec_with_credential(&self, cwd: &Path, credential: Option<&str>) -> CommandSpec {
        let spec = self.spec(cwd);
        match credential {
            None => spec,
            Some(token) => spec
                .arg("-c")
                .arg("credential.helper=")
                .arg("-c")
                .arg(format!("credential.helper={CREDENTIAL_HELPER}"))
                .env(CREDENTIAL_ENV, token)
                .secret(token),
        }
    }

    pub(super) fn run(&self, spec: CommandSpec, cancel: &CancelToken) -> Result<String, AppError> {
        let outcome = exec::run(spec, cancel)?;
        if !outcome.success() {
            let detail = if outcome.timed_out {
                "the command timed out".to_string()
            } else if outcome.cancelled {
                "the command was cancelled".to_string()
            } else {
                let stderr = outcome.stderr.trim();
                if stderr.is_empty() {
                    format!("git exited with {:?}", outcome.exit_code)
                } else {
                    stderr.to_string()
                }
            };
            return Err(AppError::new("git_failed", detail));
        }
        if outcome.stdout_truncated {
            return Err(AppError::new(
                "git_output_limit",
                "Git output exceeded the bounded parser limit.",
            ));
        }
        Ok(outcome.stdout)
    }

    /// Resolve the working-tree root that contains `folder`.
    ///
    /// The result is compared against the folder the user actually selected by
    /// the caller. `git rev-parse` walks upwards, so a folder that merely sits
    /// inside someone else's repository would otherwise silently bind to that
    /// parent repository instead.
    pub fn discover_root(&self, folder: &Path, cancel: &CancelToken) -> Result<PathBuf, AppError> {
        let spec = self
            .spec(folder)
            .arg("rev-parse")
            .arg("--show-toplevel")
            .deadline(Duration::from_secs(20));
        let stdout = self.run(spec, cancel)?;
        let root = stdout.trim();
        if root.is_empty() {
            return Err(AppError::new(
                "git_not_a_repository",
                "That folder is not inside a Git repository.",
            ));
        }
        Ok(PathBuf::from(normalize(root)))
    }

    /// True when `folder` is itself the root of a repository, rather than a
    /// subdirectory of one.
    pub fn is_repository_root(&self, folder: &Path, cancel: &CancelToken) -> bool {
        match self.discover_root(folder, cancel) {
            Ok(root) => same_path(&root, folder),
            Err(_) => false,
        }
    }

    pub fn state(&self, root: &Path, cancel: &CancelToken) -> Result<RepositoryState, AppError> {
        let head = self.head(root, cancel)?;
        let branch = self.current_branch(root, cancel)?;
        let status = self.run(
            self.spec(root)
                .arg("status")
                .arg("--porcelain=v1")
                .arg("--untracked-files=normal")
                .arg("--no-renames")
                .arg("-z"),
            cancel,
        )?;

        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        let mut untracked = Vec::new();
        for line in status.split('\0') {
            if line.len() < 4 {
                continue;
            }
            let (code, path) = line.split_at(2);
            let path = path.strip_prefix(' ').unwrap_or(path).to_string();
            let mut chars = code.chars();
            let index = chars.next().unwrap_or(' ');
            let worktree = chars.next().unwrap_or(' ');
            if index == '?' && worktree == '?' {
                untracked.push(path);
                continue;
            }
            if index != ' ' {
                staged.push(path.clone());
            }
            if worktree != ' ' {
                unstaged.push(path);
            }
        }

        Ok(RepositoryState {
            root: normalize(&root.to_string_lossy()),
            unborn: head.is_none(),
            head,
            branch,
            dirty: !staged.is_empty() || !unstaged.is_empty() || !untracked.is_empty(),
            staged_paths: staged,
            unstaged_paths: unstaged,
            untracked_paths: untracked,
            remotes: self.remotes(root, cancel)?,
        })
    }

    /// Current commit, or `None` in a repository with no commits yet. An unborn
    /// repository is a normal starting state, not an error.
    pub fn head(&self, root: &Path, cancel: &CancelToken) -> Result<Option<String>, AppError> {
        let outcome = exec::run(self.spec(root).arg("rev-parse").arg("HEAD"), cancel)?;
        if outcome.success() {
            return Ok(Some(outcome.stdout.trim().to_string()));
        }
        if outcome.stderr.contains("unknown revision")
            || outcome.stderr.contains("ambiguous argument")
            || outcome.stderr.contains("does not have any commits")
        {
            return Ok(None);
        }
        Err(AppError::new(
            "git_head_failed",
            outcome.stderr.trim().to_string(),
        ))
    }

    pub fn current_branch(
        &self,
        root: &Path,
        cancel: &CancelToken,
    ) -> Result<Option<String>, AppError> {
        let outcome = exec::run(
            self.spec(root)
                .arg("symbolic-ref")
                .arg("--short")
                .arg("HEAD"),
            cancel,
        )?;
        if outcome.success() {
            let branch = outcome.stdout.trim().to_string();
            return Ok((!branch.is_empty()).then_some(branch));
        }
        // Detached HEAD is a legitimate state, not a failure.
        Ok(None)
    }

    pub fn remotes(&self, root: &Path, cancel: &CancelToken) -> Result<Vec<Remote>, AppError> {
        let stdout = self.run(self.spec(root).arg("remote").arg("-v"), cancel)?;
        let mut remotes: Vec<Remote> = Vec::new();
        for line in stdout.lines() {
            let mut parts = line.split_whitespace();
            let (Some(name), Some(url)) = (parts.next(), parts.next()) else {
                continue;
            };
            if !remotes.iter().any(|remote| remote.name == name) {
                remotes.push(Remote {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }
        Ok(remotes)
    }

    /// Initialise a repository with an explicit initial branch, so the result
    /// does not depend on the host's `init.defaultBranch`.
    pub fn init(
        &self,
        root: &Path,
        initial_branch: &str,
        cancel: &CancelToken,
    ) -> Result<(), AppError> {
        validate_branch_name(initial_branch)?;
        self.run(
            self.spec(root)
                .arg("init")
                .arg("--initial-branch")
                .arg(initial_branch),
            cancel,
        )?;
        Ok(())
    }

    /// Stage exactly these paths and nothing else.
    ///
    /// `--` separates paths from options, so a file whose name begins with a
    /// dash is treated as a path rather than a flag. `--pathspec-file-nul` is
    /// not used because each path is already a separate argv entry.
    pub fn stage_exact(
        &self,
        root: &Path,
        paths: &[String],
        cancel: &CancelToken,
    ) -> Result<(), AppError> {
        if paths.is_empty() {
            return Err(AppError::new(
                "git_nothing_to_stage",
                "No paths were selected for staging.",
            ));
        }
        let mut spec = self
            .spec(root)
            .arg("add")
            .arg("--")
            .args(paths.iter().cloned());
        spec = spec.deadline(Duration::from_secs(120));
        self.run(spec, cancel)?;
        Ok(())
    }

    /// Paths currently staged, used to refuse a commit that would sweep up
    /// files the user never reviewed.
    pub fn staged_paths(&self, root: &Path, cancel: &CancelToken) -> Result<Vec<String>, AppError> {
        let outcome = exec::run(
            self.spec(root)
                .arg("diff")
                .arg("--cached")
                .arg("--name-only")
                .arg("-z"),
            cancel,
        )?;
        if !outcome.success() {
            // An unborn repository has no diff base; fall back to the index.
            let listed = self.run(
                self.spec(root).arg("ls-files").arg("--cached").arg("-z"),
                cancel,
            )?;
            return Ok(listed
                .split('\0')
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect());
        }
        Ok(outcome
            .stdout
            .split('\0')
            .map(str::to_string)
            .filter(|line| !line.is_empty())
            .collect())
    }

    /// Commit exactly what is staged.
    ///
    /// The message is passed as a separate argv entry, so its content - however
    /// it is punctuated - is never parsed as an option or as shell syntax.
    pub fn commit(
        &self,
        root: &Path,
        message: &str,
        author: Option<(&str, &str)>,
        cancel: &CancelToken,
    ) -> Result<CommitOutcome, AppError> {
        if message.trim().is_empty() {
            return Err(AppError::new(
                "git_empty_message",
                "A commit message is required.",
            ));
        }
        let before_head = self.head(root, cancel)?;
        let committed_paths = self.staged_paths(root, cancel)?;
        if committed_paths.is_empty() {
            return Err(AppError::new(
                "git_nothing_staged",
                "Nothing is staged, so there is nothing to commit.",
            ));
        }

        let mut spec = self.spec(root);
        if let Some((name, email)) = author {
            spec = spec
                .env("GIT_AUTHOR_NAME", name)
                .env("GIT_AUTHOR_EMAIL", email)
                .env("GIT_COMMITTER_NAME", name)
                .env("GIT_COMMITTER_EMAIL", email);
        }
        // --only with no pathspec would commit nothing; the index is already
        // exactly what was staged, so a plain commit is correct here.
        self.run(spec.arg("commit").arg("--message").arg(message), cancel)?;

        let after_head = self.head(root, cancel)?.ok_or_else(|| {
            AppError::new("git_commit_failed", "The commit did not create a HEAD.")
        })?;

        Ok(CommitOutcome {
            before_head,
            after_head,
            committed_paths,
            // A commit alone pushes nothing; the caller sets this if it pushes.
            pushed: None,
        })
    }

    /// Point `remote` at `url`, replacing any existing entry of that name.
    ///
    /// The URL comes from GitHub's own response to creating the repository,
    /// never from a caller, and carries no credential: authentication stays
    /// with Git's credential helper.
    pub fn set_remote(
        &self,
        root: &Path,
        remote: &str,
        url: &str,
        cancel: &CancelToken,
    ) -> Result<(), AppError> {
        validate_remote_name(remote)?;
        if !url.starts_with("https://github.com/") {
            return Err(AppError::new(
                "invalid_remote_url",
                "A remote URL must be an https github.com address.",
            ));
        }
        let existing = self.remotes(root, cancel)?;
        let verb = if existing.iter().any(|candidate| candidate.name == remote) {
            "set-url"
        } else {
            "add"
        };
        self.run(
            self.spec(root).arg("remote").arg(verb).arg(remote).arg(url),
            cancel,
        )?;
        Ok(())
    }

    /// Push an existing commit to a remote branch.
    ///
    /// `credential` is the token the user granted this app when they connected
    /// GitHub. Passing it makes publication depend on that one consent rather
    /// than on whatever credential happens to be sitting in the machine's Git
    /// credential manager, which is what made a fresh installation behave
    /// differently from a developer's. Passing `None` leaves authentication to
    /// Git, which is the pre-existing behaviour for an installation that never
    /// connected an account.
    ///
    /// The token reaches Git through `credential_env`: an environment variable
    /// read by a helper defined for this one invocation. It is never written
    /// into the remote URL, into `.git/config`, into any file, or into argv
    /// where another local process could read it from the process list, and it
    /// is registered as a secret so it cannot appear in captured output.
    ///
    /// `--force` is never passed and the refspec is always fully qualified, so
    /// this can only fast-forward a branch and can never rewrite remote history.
    pub fn push(
        &self,
        root: &Path,
        remote: &str,
        branch: &str,
        credential: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<PushOutcome, AppError> {
        validate_remote_name(remote)?;
        validate_branch_name(branch)?;

        let head = self
            .head(root, cancel)?
            .ok_or_else(|| AppError::new("git_unborn", "There is no commit to push yet."))?;

        if self.current_branch(root, cancel)?.as_deref() != Some(branch) {
            return Err(AppError::new(
                "publication_branch_mismatch",
                "The current branch differs from the destination branch.",
            ));
        }
        let refspec = format!("{head}:refs/heads/{branch}");
        self.run(
            self.spec_with_credential(root, credential)
                .arg("push")
                .arg("--porcelain")
                .arg(remote)
                .arg(&refspec),
            cancel,
        )?;

        Ok(PushOutcome {
            remote: remote.to_string(),
            branch: branch.to_string(),
            pushed_head: head,
            verified_remote_head: None,
            repository: None,
        })
    }
}

/// Remote names go into argv, so reject anything that could be read as an
/// option or as a URL rather than a configured remote.
pub fn validate_remote_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::new(
            "git_bad_remote",
            "A remote name must be between 1 and 100 characters.",
        ));
    }
    if name.starts_with("-") {
        return Err(AppError::new(
            "git_bad_remote",
            "A remote name cannot start with a dash.",
        ));
    }
    if name.contains(":") || name.contains("/") || name.contains("\\") {
        return Err(AppError::new(
            "git_bad_remote",
            "A remote name cannot look like a URL or a path.",
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::new(
            "git_bad_remote",
            "A remote name may use letters, digits, dot, dash and underscore only.",
        ));
    }
    Ok(())
}

/// Reject anything Git would not accept as a branch name, and a few things it
/// would accept but that would be ambiguous or dangerous as an argument.
pub fn validate_branch_name(name: &str) -> Result<(), AppError> {
    let invalid = name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains('\0')
        || name.contains(' ')
        || name.contains('~')
        || name.contains('^')
        || name.contains(':')
        || name.contains('?')
        || name.contains('*')
        || name.contains('[')
        || name.contains('\\')
        || name.chars().any(|c| c.is_control());
    if invalid {
        return Err(AppError::new(
            "invalid_branch_name",
            format!("'{name}' is not a valid Git branch name."),
        ));
    }
    Ok(())
}

fn normalize(path: &str) -> String {
    crate::settings::normalize_windows_verbatim_prefix(path)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let canon = |path: &Path| {
        std::fs::canonicalize(path)
            .map(|resolved| normalize(&resolved.to_string_lossy()).to_lowercase())
            .unwrap_or_else(|_| normalize(&path.to_string_lossy()).to_lowercase())
    };
    canon(left) == canon(right)
}
