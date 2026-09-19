//! Immutable reviewed bytes. No hook or clean-filter code is executed.
use super::exec::CancelToken;
use super::git::{CommitOutcome, GitService};
use crate::error::AppError;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
pub struct SnapshotFile {
    pub path: String,
    pub mode: u32,
    pub bytes: Option<Vec<u8>>,
}
pub struct Snapshot {
    pub files: Vec<SnapshotFile>,
    pub digest: String,
}

pub fn validate_path(path: &str) -> Result<String, AppError> {
    if path.is_empty()
        || path.len() > 512
        || path != path.trim()
        || path.starts_with('/')
        || path.starts_with('-')
        || path
            .chars()
            .any(|c| c.is_control() || "\\:*?[]".contains(c))
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(AppError::new(
            "invalid_path",
            "Name an exact repository-relative file.",
        ));
    }
    if path.to_ascii_lowercase().split('/').any(|p| {
        p == ".git"
            || p == ".env"
            || p.starts_with(".env.")
            || ["credentials", "secrets", "id_rsa", "id_ed25519"].contains(&p)
            || [".pem", ".key", ".p12", ".pfx"]
                .iter()
                .any(|suffix| p.ends_with(suffix))
    }) {
        return Err(AppError::new(
            "sensitive_path",
            "Sensitive files cannot be planned for commit.",
        ));
    }
    Ok(path.to_string())
}

pub fn capture(root: &Path, paths: &[String]) -> Result<Snapshot, AppError> {
    if paths.len() > 50 {
        return Err(AppError::new(
            "invalid_paths",
            "At most fifty files may be reviewed.",
        ));
    }
    let root = fs::canonicalize(root)?;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut hash = Sha256::new();
    for path in paths {
        let path = validate_path(path)?;
        if !seen.insert(path.clone()) {
            return Err(AppError::new("invalid_paths", "Duplicate file path."));
        }
        let pieces: Vec<&str> = path.split('/').collect();
        let mut parent = root.clone();
        for piece in &pieces[..pieces.len() - 1] {
            parent.push(piece);
            match fs::symlink_metadata(&parent) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => {
                    return Err(AppError::new(
                        "unsafe_path",
                        "A path ancestor is a link or is not a directory.",
                    ))
                }
            }
        }
        let full = root.join(&path);
        let (mode, bytes) = match fs::symlink_metadata(&full) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (0, None),
            Err(e) => return Err(e.into()),
            Ok(meta) if meta.is_dir() => {
                return Err(AppError::new(
                    "path_is_directory",
                    "Review explicit files, not directories.",
                ))
            }
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = fs::read_link(&full)?;
                let text = target.to_str().ok_or_else(|| {
                    AppError::new("unsupported_path", "Link target is not UTF-8.")
                })?;
                (0o120000, Some(text.as_bytes().to_vec()))
            }
            Ok(meta) if meta.is_file() => {
                if meta.len() > MAX_FILE {
                    return Err(AppError::new(
                        "snapshot_limit",
                        "A reviewed file exceeds 16 MiB.",
                    ));
                }
                let mut bytes = Vec::new();
                File::open(&full)?
                    .take(MAX_FILE + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 > MAX_FILE {
                    return Err(AppError::new(
                        "snapshot_limit",
                        "File grew beyond its limit.",
                    ));
                }
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    if meta.permissions().mode() & 0o111 != 0 {
                        0o100755
                    } else {
                        0o100644
                    }
                };
                #[cfg(not(unix))]
                let mode = 0o100644;
                (mode, Some(bytes))
            }
            _ => {
                return Err(AppError::new(
                    "unsafe_path",
                    "Special files cannot be committed.",
                ))
            }
        };
        total += bytes.as_ref().map_or(0, Vec::len);
        if total > MAX_TOTAL {
            return Err(AppError::new(
                "snapshot_limit",
                "Reviewed content exceeds 64 MiB.",
            ));
        }
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update((mode as u32).to_le_bytes());
        match &bytes {
            Some(bytes) => {
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            }
            None => hash.update(b"absent"),
        }
        hash.update([0]);
        files.push(SnapshotFile { path, mode, bytes });
    }
    let digest = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(Snapshot { files, digest })
}

struct IndexGuard {
    lock_path: PathBuf,
    temporary: PathBuf,
    owned: bool,
}
impl Drop for IndexGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary);
        let _ = fs::remove_file(PathBuf::from(format!(
            "{}.lock",
            self.temporary.to_string_lossy()
        )));
        if self.owned {
            let _ = fs::remove_file(&self.lock_path);
        }
    }
}

impl GitService {
    pub fn commit_snapshot(
        &self,
        root: &Path,
        snapshot: &Snapshot,
        before: Option<&str>,
        branch: &str,
        message: &str,
        cancel: &CancelToken,
    ) -> Result<CommitOutcome, AppError> {
        super::git::validate_branch_name(branch)?;
        if message.trim().is_empty() || message.len() > 4000 || message.contains('\0') {
            return Err(AppError::new(
                "invalid_message",
                "A bounded, nonempty commit message is required.",
            ));
        }
        let index_text = self.run(
            self.spec(root)
                .arg("rev-parse")
                .arg("--git-path")
                .arg("index"),
            cancel,
        )?;
        let index = PathBuf::from(index_text.trim());
        let index = if index.is_absolute() {
            index
        } else {
            root.join(index)
        };
        let lock_path = PathBuf::from(format!("{}.lock", index.to_string_lossy()));
        let mut lock = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .map_err(|_| {
                AppError::new(
                    "repository_busy",
                    "Git's index is locked. No commit was started.",
                )
            })?;
        let temporary = index.with_file_name(format!(
            "secret-tunnel-index-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let mut guard = IndexGuard {
            lock_path,
            temporary: temporary.clone(),
            owned: true,
        };
        let wanted: Vec<String> = snapshot.files.iter().map(|f| f.path.clone()).collect();
        if self
            .staged_paths(root, cancel)?
            .iter()
            .any(|p| !wanted.contains(p))
        {
            return Err(AppError::new(
                "unreviewed_staged_paths",
                "Unrelated staged files were not included in this approval.",
            ));
        }
        if self.head(root, cancel)?.as_deref() != before
            || self.current_branch(root, cancel)?.as_deref() != Some(branch)
        {
            return Err(AppError::new(
                "local_head_moved",
                "The branch or its HEAD changed before commit.",
            ));
        }
        let isolated = || {
            self.spec(root)
                .env("GIT_INDEX_FILE", temporary.to_string_lossy().into_owned())
        };
        self.run(
            match before {
                Some(id) => isolated().arg("read-tree").arg(id),
                None => isolated().arg("read-tree").arg("--empty"),
            },
            cancel,
        )?;
        for file in &snapshot.files {
            if let Some(bytes) = &file.bytes {
                let object = self.run(
                    self.spec(root)
                        .arg("hash-object")
                        .arg("-w")
                        .arg("--no-filters")
                        .arg("--stdin")
                        .input(bytes.clone()),
                    cancel,
                )?;
                #[allow(unused_mut)]
                let mut mode = file.mode;
                #[cfg(windows)]
                if mode == 0o100644 {
                    if let Some(parent) = before {
                        let existing = self.run(
                            self.spec(root)
                                .arg("ls-tree")
                                .arg("-z")
                                .arg(parent)
                                .arg("--")
                                .arg(&file.path),
                            cancel,
                        )?;
                        if existing.starts_with("100755 ") {
                            mode = 0o100755;
                        }
                    }
                }
                self.run(
                    isolated()
                        .arg("update-index")
                        .arg("--add")
                        .arg("--cacheinfo")
                        .arg(format!("{mode:o}"))
                        .arg(object.trim())
                        .arg(&file.path),
                    cancel,
                )?;
            } else {
                self.run(
                    isolated()
                        .arg("update-index")
                        .arg("--force-remove")
                        .arg("--")
                        .arg(&file.path),
                    cancel,
                )?;
            }
        }
        let tree = self.run(isolated().arg("write-tree"), cancel)?;
        if let Some(parent) = before {
            let old_tree = self.run(
                self.spec(root)
                    .arg("rev-parse")
                    .arg(format!("{parent}^{{tree}}")),
                cancel,
            )?;
            if old_tree.trim() == tree.trim() {
                return Err(AppError::new(
                    "git_nothing_staged",
                    "The approved snapshot has no changes.",
                ));
            }
        }
        let mut create = self
            .spec(root)
            .arg("-c")
            .arg("commit.gpgSign=false")
            .arg("commit-tree")
            .arg(tree.trim());
        if let Some(parent) = before {
            create = create.arg("-p").arg(parent);
        }
        let after = self
            .run(create.arg("-m").arg(message), cancel)?
            .trim()
            .to_string();
        lock.write_all(&fs::read(&temporary)?)?;
        lock.sync_all()?;
        if self.current_branch(root, cancel)?.as_deref() != Some(branch) {
            return Err(AppError::new(
                "branch_changed",
                "The current branch changed before the ref update.",
            ));
        }
        self.run(
            self.spec(root)
                .arg("update-ref")
                .arg("-m")
                .arg(message)
                .arg(format!("refs/heads/{branch}"))
                .arg(&after)
                .arg(before.unwrap_or("0000000000000000000000000000000000000000")),
            cancel,
        )?;
        drop(lock);
        // A failure here is an uncertain outcome: the branch may already be updated.
        fs::rename(&guard.lock_path, &index)?;
        guard.owned = false;
        Ok(CommitOutcome {
            before_head: before.map(str::to_string),
            after_head: after,
            committed_paths: wanted,
            pushed: None,
        })
    }
}
