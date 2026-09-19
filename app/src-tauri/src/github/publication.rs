//! A publication is a commit identity plus one explicit, verified destination.
//! No force push, implicit refspec, multi-push URL, mirror or URL rewrite is accepted.
use super::exec::{self, CancelToken};
use super::git::{validate_branch_name, GitService, PushOutcome};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationTarget {
    pub remote: String,
    pub url: String,
    pub repository: String,
    pub branch: String,
}

pub fn github_repository(url: &str) -> Result<String, AppError> {
    // Deliberately HTTPS-only for the managed publication path. SSH and custom
    // transports require their own explicit, tested credential/destination policy.
    let path = url.strip_prefix("https://github.com/").ok_or_else(|| {
        AppError::new(
            "unsupported_push_transport",
            "Managed publication requires one HTTPS github.com remote.",
        )
    })?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || p.len() > 100
                || p.starts_with('.')
                || p.starts_with('-')
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err(AppError::new("invalid_remote_url", "A remote must name one GitHub owner and repository, without credentials, query or fragment."));
    }
    Ok(format!("{}/{}", parts[0], parts[1]).to_ascii_lowercase())
}

impl GitService {
    pub fn publication_target(
        &self,
        root: &Path,
        owner: &str,
        repo: &str,
        branch: &str,
        cancel: &CancelToken,
    ) -> Result<PublicationTarget, AppError> {
        validate_branch_name(branch)?;
        if self.current_branch(root, cancel)?.as_deref() != Some(branch) {
            return Err(AppError::new(
                "publication_branch_mismatch",
                "Checkout the bound integration branch before planning or applying publication.",
            ));
        }
        // A validated URL must not be rewritten a second time when handed to push.
        let rewrites = exec::run(
            self.spec(root)
                .arg("config")
                .arg("--get-regexp")
                .arg("^url\\..*\\.(insteadof|pushinsteadof)$"),
            cancel,
        )?;
        if rewrites.success() || (rewrites.exit_code != Some(1)) {
            return Err(AppError::new(
                "push_configuration_unsupported",
                "URL rewrite rules must be removed from this managed publication path locally.",
            ));
        }
        let mirror = exec::run(
            self.spec(root)
                .arg("config")
                .arg("--bool")
                .arg("--get")
                .arg("remote.origin.mirror"),
            cancel,
        )?;
        if !(mirror.exit_code == Some(1) || (mirror.success() && mirror.stdout.trim() == "false")) {
            return Err(AppError::new(
                "push_configuration_unsupported",
                "Mirror publication is not supported.",
            ));
        }
        let output = self.run(
            self.spec(root)
                .arg("remote")
                .arg("get-url")
                .arg("--push")
                .arg("--all")
                .arg("origin"),
            cancel,
        )?;
        let urls: Vec<&str> = output.lines().filter(|line| !line.is_empty()).collect();
        if urls.len() != 1 {
            return Err(AppError::new(
                "ambiguous_push_target",
                "Exactly one effective origin push URL is required.",
            ));
        }
        let repository = github_repository(urls[0])?;
        if repository != format!("{owner}/{repo}").to_ascii_lowercase() {
            return Err(AppError::new(
                "publication_repository_mismatch",
                "Git origin does not point at the repository named in the binding.",
            ));
        }
        Ok(PublicationTarget {
            remote: "origin".to_string(),
            url: urls[0].to_string(),
            repository,
            branch: branch.to_string(),
        })
    }

    /// Read the remote branch tip. `credential` is the connected account's
    /// token; a private repository will not answer without one.
    pub fn remote_tip(
        &self,
        root: &Path,
        target: &PublicationTarget,
        credential: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<Option<String>, AppError> {
        github_repository(&target.url)?;
        validate_branch_name(&target.branch)?;
        let reference = format!("refs/heads/{}", target.branch);
        let output = self.run(
            self.network_spec(root, credential)
                .arg("ls-remote")
                .arg("--refs")
                .arg(&target.url)
                .arg(&reference)
                .deadline(Duration::from_secs(20)),
            cancel,
        )?;
        let mut found = None;
        for line in output.lines() {
            let mut parts = line.split_whitespace();
            let id = parts.next().unwrap_or("");
            if parts.next() != Some(reference.as_str()) || !valid_oid(id) || found.is_some() {
                return Err(AppError::new(
                    "remote_state_invalid",
                    "The remote returned an unexpected reference identity.",
                ));
            }
            found = Some(id.to_string());
        }
        Ok(found)
    }

    fn network_spec(&self, root: &Path, credential: Option<&str>) -> super::exec::CommandSpec {
        self.spec_with_credential(root, credential)
            .arg("-c")
            .arg("protocol.allow=never")
            .arg("-c")
            .arg("protocol.https.allow=always")
            .arg("-c")
            .arg("http.followRedirects=false")
            .arg("-c")
            .arg("push.followTags=false")
            .arg("-c")
            .arg("push.recurseSubmodules=no")
    }

    pub fn push_approved(
        &self,
        root: &Path,
        target: &PublicationTarget,
        source: &str,
        expected_tip: Option<&str>,
        credential: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<PushOutcome, AppError> {
        if !valid_oid(source) {
            return Err(AppError::new("git_invalid_oid", "Invalid source commit."));
        }
        let (owner, repo) = target
            .repository
            .split_once('/')
            .ok_or_else(|| AppError::new("invalid_remote_url", "Invalid repository identity."))?;
        let current = self.publication_target(root, owner, repo, &target.branch, cancel)?;
        if &current != target {
            return Err(AppError::new(
                "publication_changed",
                "The push destination changed after approval.",
            ));
        }
        if self.head(root, cancel)?.as_deref() != Some(source) {
            return Err(AppError::new(
                "local_head_moved",
                "The approved source commit is no longer HEAD.",
            ));
        }
        if self
            .remote_tip(root, target, credential, cancel)?
            .as_deref()
            != expected_tip
        {
            return Err(AppError::new(
                "remote_moved",
                "The remote branch changed after approval. Inspect and plan again.",
            ));
        }
        // Pin the SOURCE OBJECT, never a branch that can silently refer elsewhere.
        let refspec = format!("{source}:refs/heads/{}", target.branch);
        self.run(
            self.network_spec(root, credential)
                .arg("push")
                .arg("--porcelain")
                .arg("--no-verify")
                .arg("--no-follow-tags")
                .arg("--recurse-submodules=no")
                .arg(&target.url)
                .arg(refspec),
            cancel,
        )?;
        let observed = self.remote_tip(root, target, credential, cancel)?;
        if observed.as_deref() != Some(source) {
            return Err(AppError::new("push_unverified", "The push returned but its destination could not be verified. Reconcile; do not replay automatically."));
        }
        Ok(PushOutcome {
            remote: target.remote.clone(),
            branch: target.branch.clone(),
            pushed_head: source.to_string(),
            verified_remote_head: observed,
            repository: Some(target.repository.clone()),
        })
    }
}

fn valid_oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_urls_are_exact_and_credential_free() {
        assert_eq!(
            github_repository("https://github.com/Owner/Repo.git").unwrap(),
            "owner/repo"
        );
        for url in [
            "https://github.com.evil.invalid/o/r",
            "https://github.com/o/r?x=1",
            "https://github.com/o/r#x",
            "https://github.com/o/r/extra",
            "https://github.com/../r",
            "https://user@github.com/o/r",
            "ssh://git@github.com/o/r",
            "file:///tmp/r",
        ] {
            assert!(github_repository(url).is_err(), "must refuse {url}");
        }
    }
}
