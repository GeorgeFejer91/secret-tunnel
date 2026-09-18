//! Desktop-owned plans, approvals, serialized execution and durable receipts.
//! Public tools can propose and apply; only the local desktop can approve.
use super::exec::{resolve_tool, CancelToken, Tool};
use super::git::{CommitOutcome, GitService};
use super::operations::{OperationJournal, OperationReceipt, OperationState, CONTRACT_VERSION};
use super::plan::{build_plan, now_secs, ExpectedState, Plan, PlanAction, PlanStore};
use super::snapshot::{self, Snapshot};
use crate::error::AppError;
use crate::settings::{
    load_or_create_settings, save_settings, settings_revision, AccessMode, AppPaths,
    RepositoryBinding, Settings,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub application_version: String,
    pub build_id: String,
    pub instance_id: String,
    pub contract_version: u32,
}

/// Where `ensure_pages` puts the workflow, and the only workflow this app
/// treats as the one that deploys the site.
const PAGES_WORKFLOW_PATH: &str = ".github/workflows/pages.yml";

/// Minimal Actions Pages workflow: publish the repository root as a static
/// site. Deterministic and pinned to major versions of the official actions.
const PAGES_WORKFLOW: &str = r#"name: Deploy static site to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
"#;

/// What `ensure_pages` did. The workflow still has to be published.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesSetup {
    pub workflow_path: String,
    /// False when a workflow was already present and was left untouched.
    pub workflow_written: bool,
    /// "enabled" or "already_enabled".
    pub pages: String,
    pub branch: String,
    /// The custom domain GitHub reports for the site, absent when none was
    /// asked for. Read back from GitHub, never echoed from the request.
    pub domain: Option<String>,
    /// GitHub's own https_enforced flag for the site.
    pub https_enforced: bool,
    /// Why HTTPS is not enforced yet, when it was requested and refused.
    pub note: Option<String>,
}

/// The repository this workspace is bound to after `ensure_repository`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsuredRepository {
    pub owner: String,
    pub repo: String,
    pub repository_id: u64,
    pub html_url: String,
    pub branch: String,
    /// False when an existing binding was reused.
    pub created: bool,
}

/// Exactly what the Pages verifier is bound to. No credential, no URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesContext {
    pub repository: String,
    pub repository_id: u64,
    pub commit: String,
    pub branch: String,
    /// The custom domain this app configured for this exact binding, and the
    /// only non-default origin the verifier may fetch.
    pub pages_domain: Option<String>,
    /// The Pages workflow present in the workspace. For an Actions-built site
    /// its run is the only per-commit deployment evidence GitHub publishes.
    pub workflow_path: Option<String>,
    /// GitHub's record of the site. Read here because that endpoint needs a
    /// credential, which the verifier deliberately does not carry.
    pub pages_site: Option<super::account::PagesSite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub enabled: bool,
    pub git_available: bool,
    pub git_version: Option<String>,
    pub workspace_path: Option<String>,
    pub is_repository: bool,
    pub repository: Option<super::git::RepositoryState>,
    pub binding: Option<RepositoryBinding>,
    pub pending_plans: Vec<Plan>,
    pub approved_plans: Vec<Plan>,
    pub recent_operations: Vec<OperationReceipt>,
    pub blocked_reason: Option<String>,
    pub blocked_code: Option<String>,
    pub runtime: RuntimeIdentity,
    // Stored API login is NOT proof that Git's transport can authenticate.
    pub api_account_stored: bool,
    pub git_credential_provider: String,
    /// Flattened, so `githubConnected`, `approvalMode`, `autonomous` and
    /// `publicationAuthentication` read as ordinary fields of the status a
    /// caller already asks for.
    #[serde(flatten)]
    pub authorization: AuthorizationState,
}

/// Whether this installation may act, and as whom.
///
/// Deliberately cheap: no Git process and no network, so it can be answered on
/// the runtime-status path that must work even when the workspace is broken.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationState {
    /// Whether this app holds its own GitHub connection, as distinct from a
    /// credential it happened to find on the machine.
    pub github_connected: bool,
    pub account_login: Option<String>,
    pub account_scope: Option<String>,
    pub approval_mode: crate::settings::ApprovalMode,
    /// The same fact as `approval_mode`, stated as the question a caller
    /// actually has: may I act without a desktop click?
    pub autonomous: bool,
    /// Which credential a managed push would authenticate with.
    pub publication_authentication: String,
}

pub struct GitHubCoordinator {
    paths: AppPaths,
    plans: PlanStore,
    git: Mutex<Option<Arc<GitService>>>,
    execution: Mutex<()>,
    actions: Mutex<Option<crate::actions::ActionsState>>,
    active_operation: Mutex<Option<String>>,
    journal: OperationJournal,
    identity: RuntimeIdentity,
}

impl GitHubCoordinator {
    pub fn new(paths: AppPaths) -> Self {
        let instance_id = uuid::Uuid::new_v4().simple().to_string();
        let journal = OperationJournal::new(&paths.config_dir, instance_id.clone());
        let identity = RuntimeIdentity {
            application_version: env!("CARGO_PKG_VERSION").to_string(),
            build_id: crate::diag::executable_fingerprint(),
            instance_id,
            contract_version: CONTRACT_VERSION,
        };
        Self {
            paths,
            plans: PlanStore::new(),
            git: Mutex::new(None),
            execution: Mutex::new(()),
            actions: Mutex::new(None),
            active_operation: Mutex::new(None),
            journal,
            identity,
        }
    }
    pub(crate) fn attach_actions(
        &self,
        actions: crate::actions::ActionsState,
    ) -> Result<(), AppError> {
        *self.actions.lock().map_err(|_| {
            AppError::new("actions_lock", "Could not attach the shared Actions guard.")
        })? = Some(actions);
        Ok(())
    }
    pub fn plans(&self) -> &PlanStore {
        &self.plans
    }
    pub fn runtime_identity(&self) -> RuntimeIdentity {
        self.identity.clone()
    }
    fn mutation_guard(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.execution.try_lock().map_err(|_| {
            AppError::new(
                "github_busy",
                "A GitHub operation is active; inspect its receipt before changing state.",
            )
        })
    }
    pub fn change_settings<T>(
        &self,
        change: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let _guard = self.mutation_guard()?;
        self.plans.invalidate_all()?;
        change()
    }
    fn git(&self) -> Result<Arc<GitService>, AppError> {
        let mut slot = self
            .git
            .lock()
            .map_err(|_| AppError::new("github_state", "Git state is unavailable."))?;
        if let Some(service) = slot.as_ref() {
            return Ok(service.clone());
        }
        let service = Arc::new(GitService::new(resolve_tool(Tool::Git)?));
        *slot = Some(service.clone());
        Ok(service)
    }
    fn settings(&self) -> Result<Settings, AppError> {
        load_or_create_settings(&self.paths)
    }
    fn workspace_root(settings: &Settings) -> Option<PathBuf> {
        settings.workspace_path.as_deref().map(PathBuf::from)
    }
    fn workspace_fingerprint(settings: &Settings) -> String {
        let canonical = settings
            .workspace_path
            .as_deref()
            .and_then(|p| std::fs::canonicalize(p).ok())
            .map(|p| crate::settings::normalize_windows_verbatim_prefix(&p.to_string_lossy()))
            .unwrap_or_default();
        #[cfg(windows)]
        let canonical = canonical.to_lowercase();
        let bytes = Sha256::digest(canonical.as_bytes());
        bytes.iter().take(16).map(|b| format!("{b:02x}")).collect()
    }
    fn ensure_write(&self, settings: &Settings) -> Result<(), AppError> {
        if !settings.github.enabled {
            return Err(AppError::new(
                "github_disabled",
                "GitHub actions are turned off.",
            ));
        }
        if settings.access_mode == AccessMode::Read {
            return Err(AppError::new(
                "read_only_mode",
                "Secret Tunnel is set to Read. Switch GPT tools to Read+write.",
            ));
        }
        // An exposed workspace must never include the private approval/receipt store.
        if let Some(root) = Self::workspace_root(settings) {
            let root = std::fs::canonicalize(root)?;
            let private = std::fs::canonicalize(&self.paths.config_dir)?;
            if private.starts_with(&root) {
                return Err(AppError::new(
                    "private_store_exposed",
                    "Select a workspace that does not contain the app's private configuration.",
                ));
            }
        }
        Ok(())
    }
    /// The token the managed Git paths authenticate with, when there is one.
    ///
    /// Absent is not an error here: an installation that never connected an
    /// account keeps the previous behaviour of letting Git answer for itself.
    pub fn authorization(&self) -> Result<AuthorizationState, AppError> {
        let settings = self.settings()?;
        let account = super::account::stored_state(&self.paths.config_dir);
        Ok(AuthorizationState {
            github_connected: account.connected,
            account_login: account.login,
            account_scope: account.scope,
            approval_mode: settings.github.approval_mode,
            autonomous: settings.github.approval_mode.is_autonomous(),
            // Publication uses the app's own connection when there is one and
            // falls back to Git's credential manager otherwise, so name
            // whichever one a push would actually reach for.
            publication_authentication: if account.connected {
                "secret_tunnel_github_token".to_string()
            } else {
                "system_git_credential_helper".to_string()
            },
        })
    }
    /// The connected account's token, for the MCP direct path.
    ///
    /// The direct path calls api.github.com from the MCP process itself, so
    /// the credential has to reach it. It is handed over only across the
    /// authenticated loopback broker, only while the feature is on and writes
    /// are allowed, and only when it is *this app's own* connection: a
    /// credential merely found in the machine's Git credential manager was
    /// granted to that manager, and lending it out is not ours to do.
    pub fn direct_credential(&self) -> Result<(String, String), AppError> {
        let settings = self.settings()?;
        if !settings.github.enabled {
            return Err(AppError::new(
                "github_disabled",
                "GitHub actions are turned off.",
            ));
        }
        self.ensure_write(&settings)?;
        let (token, source) = super::account::publication_credential(&self.paths.config_dir)?;
        if source != super::account::TokenSource::ConnectedAccount {
            return Err(AppError::new(
                "github_not_connected",
                "Connect a GitHub account in Secret Tunnel before using the direct GitHub path.",
            ));
        }
        let login = super::account::stored_state(&self.paths.config_dir)
            .login
            .ok_or_else(|| {
                AppError::new("github_not_connected", "No connected account identity.")
            })?;
        Ok((token, login))
    }
    fn credential(&self) -> Result<Option<String>, AppError> {
        Ok(
            super::account::publication_credential(&self.paths.config_dir)
                .ok()
                .map(|(token, _source)| token),
        )
    }
    pub fn status(&self) -> Result<GitHubStatus, AppError> {
        let settings = self.settings()?;
        let authorization = self.authorization()?;
        let cancel = CancelToken::new();
        let service = self.git().ok();
        let root = Self::workspace_root(&settings);
        let is_repository = match (&service, &root) {
            (Some(g), Some(r)) => g.is_repository_root(r, &cancel),
            _ => false,
        };
        let repository = if is_repository {
            service
                .as_ref()
                .and_then(|g| g.state(root.as_ref().unwrap(), &cancel).ok())
        } else {
            None
        };
        let binding = settings
            .github
            .binding
            .clone()
            .filter(|b| b.workspace_fingerprint == Self::workspace_fingerprint(&settings));
        let blocked = if !settings.github.enabled {
            Some(("github_disabled", "GitHub actions are turned off."))
        } else if settings.access_mode == AccessMode::Read {
            Some((
                "read_only_mode",
                "Secret Tunnel is set to Read. Switch GPT tools to Read+write.",
            ))
        } else if service.is_none() {
            Some(("git_missing", "Git was not found on this computer."))
        } else if root.is_none() {
            Some(("no_workspace", "Select a folder first."))
        } else if !is_repository {
            Some((
                "not_a_repository_root",
                "The selected folder is not a Git repository root.",
            ))
        } else if binding.is_none() {
            Some((
                "not_bound",
                "Bind this folder to a GitHub repository before committing or pushing.",
            ))
        } else {
            None
        };
        Ok(GitHubStatus {
            enabled: settings.github.enabled,
            git_available: service.is_some(),
            git_version: service.as_ref().map(|g| g.version().to_string()),
            workspace_path: settings.workspace_path.clone(),
            is_repository,
            repository,
            binding,
            pending_plans: self.plans.pending(now_secs())?,
            approved_plans: self.plans.approved(now_secs())?,
            recent_operations: self
                .journal
                .recent()?
                .into_iter()
                .map(|r| self.reconcile_running(r))
                .collect(),
            blocked_reason: blocked.map(|b| b.1.to_string()),
            blocked_code: blocked.map(|b| b.0.to_string()),
            runtime: self.identity.clone(),
            api_account_stored: authorization.github_connected,
            git_credential_provider: authorization.publication_authentication.clone(),
            authorization,
        })
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<(), AppError> {
        self.change_settings(|| {
            let mut s = self.settings()?;
            s.github.enabled = enabled;
            save_settings(&self.paths, &s)
        })
    }
    /// The client id a connect attempt would use, without starting one.
    pub fn client_id(&self) -> Result<String, AppError> {
        super::account::resolve_client_id()
    }

    /// Record the connection the user just authorised in their browser.
    ///
    /// This is the product's authorisation step, and it is the only one. The
    /// user deliberately connected an account to this installation, and that
    /// consent covers the GitHub operations this app exposes; requiring a
    /// second desktop click per commit would be asking the same question
    /// twice. Every state-integrity check is untouched - autonomous changes
    /// who authorises a plan, not whether the plan still matches reality.
    pub fn adopt_connection(
        &self,
        device_code: &str,
    ) -> Result<super::account::PollOutcome, AppError> {
        self.change_settings(|| {
            let mut settings = self.settings()?;
            let client_id = super::account::resolve_client_id()?;
            let outcome = super::account::poll(&self.paths.config_dir, &client_id, device_code)?;
            if matches!(outcome, super::account::PollOutcome::Connected { .. }) {
                settings.github.enabled = true;
                settings.github.approval_mode = crate::settings::ApprovalMode::Autonomous;
                save_settings(&self.paths, &settings)?;
            }
            Ok(outcome)
        })
    }

    /// Forget this app's own GitHub connection and nothing else.
    ///
    /// Local repositories, GitHub repositories, the machine's Git credentials
    /// and any github.com browser session are all left exactly as they are:
    /// this disconnects Secret Tunnel, it does not sign the user out.
    pub fn forget_connection(&self) -> Result<(), AppError> {
        self.change_settings(|| {
            super::account::disconnect(&self.paths.config_dir)?;
            let mut settings = self.settings()?;
            settings.github.enabled = false;
            // The grant that authorised autonomous operation is gone, so the
            // mode it authorised goes with it.
            settings.github.approval_mode = crate::settings::ApprovalMode::Local;
            save_settings(&self.paths, &settings)
        })
    }

    pub fn bind(
        &self,
        owner: &str,
        repo: &str,
        branch: Option<String>,
    ) -> Result<RepositoryBinding, AppError> {
        self.change_settings(|| {
            let owner = validate_segment(owner, "owner")?;
            let repo = validate_segment(repo, "repository")?;
            let branch = branch.unwrap_or_else(|| "main".to_string());
            super::git::validate_branch_name(&branch)?;
            let mut settings = self.settings()?;
            let root = Self::workspace_root(&settings).ok_or_else(|| AppError::new("no_workspace", "Select a folder first."))?;
            let service = self.git()?;
            if !service.is_repository_root(&root, &CancelToken::new()) {
                return Err(AppError::new("not_a_repository_root", "Select a Git repository root."));
            }
            let actions = self.actions.lock().map_err(|_| AppError::new("actions_lock", "Shared Actions state is unavailable."))?.clone();
            let _actions_reservation = match &actions { Some(state) => Some(state.reserve_for_github()?), None => None };
            let _repo_guard = repository_guard(&service, &root)?;
            let remotes = service.remotes(&root, &CancelToken::new())?;
            let existing_origin = remotes.iter().find(|r| r.name == "origin");
            let expected_repo = format!("{owner}/{repo}").to_ascii_lowercase();
            if let Some(origin) = existing_origin {
                if super::publication::github_repository(&origin.url)? != expected_repo {
                    return Err(AppError::new("origin_mismatch", "Existing origin points elsewhere and was not changed. Review its configuration locally before linking."));
                }
            } else {
                service.set_remote(&root, "origin", &format!("https://github.com/{owner}/{repo}.git"), &CancelToken::new())?;
            }
            let binding = RepositoryBinding { workspace_fingerprint: Self::workspace_fingerprint(&settings),
                host: "github.com".to_string(), owner, repo, repository_id: None, integration_branch: branch, pages_url: None, pages_domain: None };
            settings.github.binding = Some(binding.clone());
            if let Err(error) = save_settings(&self.paths, &settings) {
                if existing_origin.is_none() {
                    return Err(AppError::new("origin_added_binding_not_saved", "Origin was added, but the desktop binding could not be saved. No commit or push occurred. Inspect settings before retrying."));
                }
                return Err(error);
            }
            Ok(binding)
        })
    }
    pub fn unbind(&self) -> Result<(), AppError> {
        self.change_settings(|| {
            let mut s = self.settings()?;
            s.github.binding = None;
            save_settings(&self.paths, &s)
        })
    }
    pub fn init_repository(&self, branch: Option<String>) -> Result<(), AppError> {
        self.change_settings(|| {
            let s = self.settings()?;
            self.ensure_write(&s)?;
            let root = Self::workspace_root(&s)
                .ok_or_else(|| AppError::new("no_workspace", "Select a folder first."))?;
            let actions = self
                .actions
                .lock()
                .map_err(|_| AppError::new("actions_lock", "Shared Actions state is unavailable."))?
                .clone();
            let _actions_reservation = match &actions {
                Some(state) => Some(state.reserve_for_github()?),
                None => None,
            };
            let canonical_root = std::fs::canonicalize(&root)?;
            let _workspace_lock = crate::actions::acquire_workspace_lock(&canonical_root)?;
            self.git()?.init(
                &root,
                &branch.unwrap_or_else(|| "main".to_string()),
                &CancelToken::new(),
            )
        })
    }
    fn observe(
        &self,
        settings: &Settings,
        action: PlanAction,
        paths: &[String],
        snapshot: Option<&Snapshot>,
    ) -> Result<ExpectedState, AppError> {
        let root = Self::workspace_root(settings)
            .ok_or_else(|| AppError::new("no_workspace", "Select a folder first."))?;
        let service = self.git()?;
        let cancel = CancelToken::new();
        if !service.is_repository_root(&root, &cancel) {
            return Err(AppError::new(
                "not_a_repository_root",
                "The workspace is no longer a repository root.",
            ));
        }
        let binding = settings
            .github
            .binding
            .as_ref()
            .filter(|b| b.workspace_fingerprint == Self::workspace_fingerprint(settings))
            .ok_or_else(|| AppError::new("not_bound", "Bind the selected repository first."))?;
        let publication = if matches!(action, PlanAction::Push | PlanAction::CommitPush) {
            Some(service.publication_target(
                &root,
                &binding.owner,
                &binding.repo,
                &binding.integration_branch,
                &cancel,
            )?)
        } else {
            None
        };
        let remote_tip = match &publication {
            // A private repository will not answer `ls-remote` unauthenticated,
            // so the same connection that authorises the push reads the tip.
            Some(target) => {
                service.remote_tip(&root, target, self.credential()?.as_deref(), &cancel)?
            }
            None => None,
        };
        Ok(ExpectedState {
            workspace_fingerprint: Self::workspace_fingerprint(settings),
            settings_revision: settings_revision(settings),
            local_head: service.head(&root, &cancel)?,
            branch: service.current_branch(&root, &cancel)?,
            remote_tip,
            content_digest: if paths.is_empty() {
                None
            } else {
                Some(match snapshot {
                    Some(s) => s.digest.clone(),
                    None => snapshot::capture(&root, paths)?.digest,
                })
            },
            publication,
            account_login: None,
        })
    }
    pub fn create_plan(
        &self,
        action: PlanAction,
        paths: Vec<String>,
        message: Option<String>,
    ) -> Result<Plan, AppError> {
        let _guard = self.mutation_guard()?;
        let settings = self.settings()?;
        self.ensure_write(&settings)?;
        if action == PlanAction::CreateRepository {
            return Err(AppError::new(
                "wrong_route",
                "Use the repository creation plan route.",
            ));
        }
        if paths.len() > 50 || (action != PlanAction::Push && paths.is_empty()) {
            return Err(AppError::new(
                "invalid_paths",
                "Commit plans require one to fifty exact files.",
            ));
        }
        if action == PlanAction::Push && (!paths.is_empty() || message.is_some()) {
            return Err(AppError::new(
                "invalid_input",
                "A push plan has no file list or commit message.",
            ));
        }
        if action != PlanAction::Push
            && message.as_deref().map_or(true, |m| {
                m.trim().is_empty() || m.len() > 4000 || m.contains('\0')
            })
        {
            return Err(AppError::new(
                "no_message",
                "A bounded nonempty commit message is required.",
            ));
        }
        let paths = paths
            .iter()
            .map(|p| snapshot::validate_path(p))
            .collect::<Result<Vec<_>, _>>()?;
        let observed = self.observe(&settings, action, &paths, None)?;
        if observed.branch.is_none() {
            return Err(AppError::new(
                "detached_head",
                "Checkout a branch before planning a change.",
            ));
        }
        if action == PlanAction::Push && observed.local_head.is_none() {
            return Err(AppError::new("git_unborn", "There is no commit to push."));
        }
        let b = settings
            .github
            .binding
            .as_ref()
            .ok_or_else(|| AppError::new("not_bound", "Bind a repository first."))?;
        let mut warnings = vec![
            "Commits preserve the reviewed bytes exactly; hooks and clean filters are not run."
                .to_string(),
        ];
        if action.touches_remote() {
            warnings.push("This publishes the reviewed commit to the exact displayed GitHub repository and branch.".to_string());
        }
        self.plans.insert(build_plan(
            action,
            format!("{}/{}", b.owner, b.repo),
            observed,
            paths,
            message,
            warnings,
        ))
    }
    fn repository_expectation(&self, settings: &Settings) -> Result<ExpectedState, AppError> {
        let (login, _) = super::account::verified_identity(&self.paths.config_dir)?;
        Ok(ExpectedState {
            workspace_fingerprint: Self::workspace_fingerprint(settings),
            settings_revision: settings_revision(settings),
            local_head: None,
            branch: None,
            remote_tip: None,
            content_digest: None,
            publication: None,
            account_login: Some(login),
        })
    }
    pub fn create_repository_plan(&self, name: &str) -> Result<Plan, AppError> {
        let _guard = self.mutation_guard()?;
        let settings = self.settings()?;
        self.ensure_write(&settings)?;
        super::account::validate_repository_name(name)?;
        let expected = self.repository_expectation(&settings)?;
        self.plans.insert(build_plan(PlanAction::CreateRepository, name.to_string(), expected, Vec::new(), None,
            vec!["Creates one private repository under the displayed verified account. It does not initialize this folder, replace origin, bind, commit or push.".to_string()]))
    }
    /// Put a minimal GitHub Actions Pages workflow in place and switch Pages on.
    ///
    /// One deployment model only: static files at the repository root published
    /// by Actions. An existing workflow file is left exactly as it is, so a
    /// project that already builds its own site keeps its own build. The
    /// workflow is written but not committed: publish it with `ship`, which is
    /// what makes the first deployment run.
    ///
    /// A custom domain is configured through GitHub's Pages API, which is what
    /// workflow-built Pages reads, and is then recorded on this binding so the
    /// verifier will accept that one origin for this one repository.
    pub fn ensure_pages(
        &self,
        domain: Option<String>,
        https_enforced: bool,
    ) -> Result<PagesSetup, AppError> {
        let settings = self.settings()?;
        self.ensure_write(&settings)?;
        let root = Self::workspace_root(&settings)
            .ok_or_else(|| AppError::new("no_workspace", "Select a folder first."))?;
        let binding = settings
            .github
            .binding
            .clone()
            .filter(|b| b.workspace_fingerprint == Self::workspace_fingerprint(&settings))
            .ok_or_else(|| {
                AppError::new(
                    "not_bound",
                    "Bind this folder to a GitHub repository first.",
                )
            })?;

        let relative = PAGES_WORKFLOW_PATH;
        let workflow = root.join(".github").join("workflows").join("pages.yml");
        let workflow_written = if workflow.exists() {
            false
        } else {
            std::fs::create_dir_all(workflow.parent().unwrap())?;
            std::fs::write(&workflow, PAGES_WORKFLOW)?;
            true
        };

        let configured = super::account::enable_pages(
            &self.paths.config_dir,
            &binding.owner,
            &binding.repo,
            domain.as_deref(),
            https_enforced,
        )?;

        // Only a domain GitHub confirms for this exact binding becomes a
        // verification target, and only after it has been set here.
        if let Some(confirmed) = configured.domain.as_deref() {
            self.store_pages_domain(&binding, confirmed)?;
        }

        Ok(PagesSetup {
            workflow_path: relative.to_string(),
            workflow_written,
            pages: configured.pages,
            branch: binding.integration_branch.clone(),
            domain: configured.domain,
            https_enforced: configured.https_enforced,
            note: configured.note,
        })
    }

    /// Commit the exact reviewed paths and publish them, in one call.
    ///
    /// Deliberately thin: it builds the same bounded `commit_push` plan the
    /// desktop builds and applies it through the same engine, so every check,
    /// the repository lock, idempotency and the durable receipt are unchanged.
    /// The only difference is who authorises it. Under `local_approval` this
    /// leaves the plan pending and returns `plan_not_approved`, which is the
    /// correct answer: the desktop has not approved it.
    pub fn ship(&self, paths: Vec<String>, message: String) -> Result<OperationReceipt, AppError> {
        let plan = self.create_plan(PlanAction::CommitPush, paths, Some(message))?;
        self.apply(&plan.id)
    }

    /// Make the selected folder a bound GitHub repository, creating one only if
    /// there is not already a usable binding.
    ///
    /// Composition of the existing pieces: create through the account API,
    /// `git init` when the folder is not yet a repository, point origin at the
    /// new remote, and bind. Refuses to retarget a workspace that is already
    /// bound, so this can be called repeatedly without surprise.
    ///
    /// `private` defaults to true at every caller that does not say otherwise:
    /// a repository that should be public can be opened later, but content
    /// published by mistake cannot be un-published.
    pub fn ensure_repository(
        &self,
        name: Option<String>,
        private: bool,
    ) -> Result<EnsuredRepository, AppError> {
        let settings = self.settings()?;
        self.ensure_write(&settings)?;
        let root = Self::workspace_root(&settings)
            .ok_or_else(|| AppError::new("no_workspace", "Select a folder first."))?;

        // Already bound: reuse it, resolving the identity anchor if it predates
        // that field. Never retarget.
        let fingerprint = Self::workspace_fingerprint(&settings);
        if let Some(bound) = settings
            .github
            .binding
            .clone()
            .filter(|b| b.workspace_fingerprint == fingerprint)
        {
            if let Some(requested) = name.as_deref() {
                if !requested.eq_ignore_ascii_case(&bound.repo) {
                    return Err(AppError::new(
                        "already_bound",
                        "This folder is already bound to a different repository. Unbind it in the desktop first.",
                    ));
                }
            }
            let id = match bound.repository_id {
                Some(id) => id,
                None => self.resolve_and_store_repository_id(&bound)?,
            };
            return Ok(EnsuredRepository {
                owner: bound.owner.clone(),
                repo: bound.repo.clone(),
                repository_id: id,
                html_url: format!("https://github.com/{}/{}", bound.owner, bound.repo),
                branch: bound.integration_branch.clone(),
                created: false,
            });
        }

        // Not bound. Name it after the folder unless told otherwise.
        let derived = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let wanted = name.unwrap_or(derived);
        super::account::validate_repository_name(&wanted)?;

        let (created, _source) =
            super::account::create_repository(&self.paths.config_dir, &wanted, private)?;
        let (owner, repo) = created.full_name.split_once('/').ok_or_else(|| {
            AppError::new("github_bad_response", "GitHub returned no owner/name.")
        })?;

        let service = self.git()?;
        let cancel = CancelToken::new();
        if !service.is_repository_root(&root, &cancel) {
            service.init(&root, &created.default_branch, &cancel)?;
        }
        service.set_remote(&root, "origin", &created.clone_url, &cancel)?;
        self.bind(owner, repo, Some(created.default_branch.clone()))?;
        if let Some(bound) = self.settings()?.github.binding.clone() {
            self.store_repository_id(&bound, created.id)?;
        }

        Ok(EnsuredRepository {
            owner: owner.to_string(),
            repo: repo.to_string(),
            repository_id: created.id,
            html_url: created.html_url.clone(),
            branch: created.default_branch,
            created: true,
        })
    }

    /// Everything the Pages verifier needs, with the identity anchor resolved.
    ///
    /// A binding made before the numeric id was recorded carries `None`. The
    /// id is GitHub's immutable handle and is what stops a renamed or
    /// re-created repository impersonating the bound one, so it is resolved
    /// from the configured owner/repo, checked against that same name, and
    /// persisted. It is never resolved from anything the caller supplies.
    pub fn pages_context(&self) -> Result<PagesContext, AppError> {
        let settings = self.settings()?;
        if !settings.github.enabled {
            return Err(AppError::new(
                "github_disabled",
                "GitHub actions are turned off.",
            ));
        }
        let fingerprint = Self::workspace_fingerprint(&settings);
        let binding = settings
            .github
            .binding
            .clone()
            .filter(|b| b.workspace_fingerprint == fingerprint)
            .ok_or_else(|| {
                AppError::new(
                    "not_bound",
                    "Bind this folder to a GitHub repository first.",
                )
            })?;

        let root = Self::workspace_root(&settings)
            .ok_or_else(|| AppError::new("no_workspace", "Select a folder first."))?;
        let service = self.git()?;
        let commit = service
            .head(&root, &CancelToken::new())?
            .ok_or_else(|| AppError::new("git_unborn", "This repository has no commit yet."))?;

        let repository_id = match binding.repository_id {
            Some(id) => id,
            None => self.resolve_and_store_repository_id(&binding)?,
        };

        Ok(PagesContext {
            repository: format!("{}/{}", binding.owner, binding.repo),
            repository_id,
            commit,
            branch: binding.integration_branch.clone(),
            pages_domain: binding.pages_domain.clone(),
            workflow_path: root
                .join(".github")
                .join("workflows")
                .join("pages.yml")
                .is_file()
                .then(|| PAGES_WORKFLOW_PATH.to_string()),
            pages_site: super::account::read_pages_site(
                &self.paths.config_dir,
                &binding.owner,
                &binding.repo,
            )?,
        })
    }

    /// Record the domain GitHub confirmed for this binding. Refuses to store
    /// one for any repository other than the one already configured, so a
    /// rebinding between the API call and this write cannot inherit the trust.
    fn store_pages_domain(
        &self,
        binding: &RepositoryBinding,
        domain: &str,
    ) -> Result<(), AppError> {
        super::account::validate_pages_domain(domain)?;
        self.change_settings(|| {
            let mut settings = self.settings()?;
            match settings.github.binding.as_mut() {
                Some(current) if current.owner == binding.owner && current.repo == binding.repo => {
                    current.pages_domain = Some(domain.to_string());
                }
                _ => {
                    return Err(AppError::new(
                        "binding_changed",
                        "The repository binding changed while its Pages domain was being recorded.",
                    ))
                }
            }
            save_settings(&self.paths, &settings)
        })
    }

    /// One authenticated read, then persist. Refuses to store an id for any
    /// repository other than the one already configured.
    /// Persist an already-known id, re-checking under the guard that the
    /// binding still names the same repository.
    fn store_repository_id(&self, binding: &RepositoryBinding, id: u64) -> Result<(), AppError> {
        self.change_settings(|| {
            let mut settings = self.settings()?;
            match settings.github.binding.as_mut() {
                Some(current) if current.owner == binding.owner && current.repo == binding.repo => {
                    current.repository_id = Some(id);
                }
                _ => {
                    return Err(AppError::new(
                        "binding_changed",
                        "The repository binding changed while its identity was being recorded.",
                    ))
                }
            }
            save_settings(&self.paths, &settings)
        })
    }

    fn resolve_and_store_repository_id(
        &self,
        binding: &RepositoryBinding,
    ) -> Result<u64, AppError> {
        let id = super::account::resolve_repository_id(
            &self.paths.config_dir,
            &binding.owner,
            &binding.repo,
        )?;
        self.change_settings(|| {
            let mut settings = self.settings()?;
            match settings.github.binding.as_mut() {
                // Re-read under the guard: only fill in the id, and only if
                // the binding still names the same repository.
                Some(current) if current.owner == binding.owner && current.repo == binding.repo => {
                    current.repository_id = Some(id);
                }
                _ => {
                    return Err(AppError::new(
                        "binding_changed",
                        "The repository binding changed while its identity was being resolved.",
                    ))
                }
            }
            save_settings(&self.paths, &settings)
        })?;
        Ok(id)
    }

    pub fn approve(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.mutation_guard()?;
        self.plans.approve(id, now_secs())?;
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.mutation_guard()?;
        self.plans.cancel(id)
    }
    pub fn operation_status(&self, id: &str) -> Result<OperationReceipt, AppError> {
        self.journal
            .get(id)?
            .map(|receipt| self.reconcile_running(receipt))
            .ok_or_else(|| {
                AppError::new(
                    "operation_unknown",
                    "No execution receipt exists for that identifier.",
                )
            })
    }
    fn reconcile_running(&self, mut receipt: OperationReceipt) -> OperationReceipt {
        let active = self.active_operation.lock().ok().and_then(|id| id.clone());
        if receipt.state == OperationState::Running
            && active.as_deref() != Some(receipt.operation_id.as_str())
        {
            // Re-read once: completion may have raced the first journal read.
            if let Ok(Some(latest)) = self.journal.get(&receipt.operation_id) {
                receipt = latest;
            }
            if receipt.state == OperationState::Running {
                receipt.state = OperationState::Unknown;
                receipt.error_code = Some("operation_not_active_reconcile_required".to_string());
            }
        }
        receipt
    }
    pub fn create_repository(&self, id: &str) -> Result<OperationReceipt, AppError> {
        self.execute(id, true)
    }
    pub fn apply(&self, id: &str) -> Result<OperationReceipt, AppError> {
        self.execute(id, false)
    }
    fn execute(&self, id: &str, creation_only: bool) -> Result<OperationReceipt, AppError> {
        let _guard = self.mutation_guard()?;
        if let Some(receipt) = self.journal.get(id)? {
            if creation_only && receipt.action != PlanAction::CreateRepository {
                return Err(AppError::new(
                    "wrong_route",
                    "Not a repository creation operation.",
                ));
            }
            return Ok(self.reconcile_running(receipt)); // Receipt lookup, never another side effect.
        }
        let settings = self.settings()?;
        self.ensure_write(&settings)?;
        let proposed = self
            .plans
            .get(id)?
            .ok_or_else(|| AppError::new("plan_unknown", "No such plan."))?;
        let actions = self
            .actions
            .lock()
            .map_err(|_| AppError::new("actions_lock", "Shared Actions state is unavailable."))?
            .clone();
        let _actions_reservation = if proposed.action != PlanAction::CreateRepository {
            match &actions {
                Some(state) => Some(state.reserve_for_github()?),
                None => None,
            }
        } else {
            None
        };
        if creation_only && proposed.action != PlanAction::CreateRepository {
            return Err(AppError::new(
                "wrong_route",
                "Not a repository creation plan.",
            ));
        }
        let root = Self::workspace_root(&settings);
        let service = if proposed.action == PlanAction::CreateRepository {
            None
        } else {
            Some(self.git()?)
        };
        // Cooperating app instances share this repository-scoped OS lock.
        let _repo_guard = match (&service, &root) {
            (Some(g), Some(r)) => Some(repository_guard(g, r)?),
            _ => None,
        };
        let captured = if proposed.paths.is_empty() {
            None
        } else {
            Some(snapshot::capture(
                root.as_ref()
                    .ok_or_else(|| AppError::new("no_workspace", "Select a folder."))?,
                &proposed.paths,
            )?)
        };
        let observed = if proposed.action == PlanAction::CreateRepository {
            self.repository_expectation(&settings)?
        } else {
            self.observe(
                &settings,
                proposed.action,
                &proposed.paths,
                captured.as_ref(),
            )?
        };
        let plan =
            self.plans
                .authorize(id, &observed, now_secs(), settings.github.approval_mode)?;
        // Refuse unrelated staged work before making an execution claim.
        if let (Some(g), Some(r), Some(_)) = (&service, &root, &captured) {
            if g.staged_paths(r, &CancelToken::new())?
                .iter()
                .any(|p| !plan.paths.contains(p))
            {
                return Err(AppError::new(
                    "unreviewed_staged_paths",
                    "Unrelated staged files were not reviewed.",
                ));
            }
        }
        let mut receipt = self.journal.begin(id, plan.action)?;
        receipt.expected = Some(plan.expected.clone());
        self.journal.save(&mut receipt)?;
        self.plans.claim(id, settings.github.approval_mode)?;
        *self
            .active_operation
            .lock()
            .map_err(|_| AppError::new("github_state", "Operation state is unavailable."))? =
            Some(id.to_string());
        let _active = ActiveOperation(&self.active_operation);
        let result = (|| -> Result<(), AppError> {
            let cancel = CancelToken::new();
            if plan.action == PlanAction::CreateRepository {
                receipt.phase = "creating_repository".to_string();
                self.journal.save(&mut receipt)?;
                let login = plan.expected.account_login.as_deref().ok_or_else(|| {
                    AppError::new("account_changed", "No verified account was bound.")
                })?;
                let (created, _) = super::account::create_repository_for(
                    &self.paths.config_dir,
                    &plan.repository,
                    login,
                )?;
                receipt.created_repository = Some(created);
                self.journal.save(&mut receipt)?;
            } else {
                let g = service
                    .as_ref()
                    .ok_or_else(|| AppError::new("git_missing", "Git is unavailable."))?;
                let r = root
                    .as_ref()
                    .ok_or_else(|| AppError::new("no_workspace", "No workspace."))?;
                if let Some(snapshot) = &captured {
                    receipt.phase = "committing".to_string();
                    self.journal.save(&mut receipt)?;
                    let branch = plan
                        .expected
                        .branch
                        .as_deref()
                        .ok_or_else(|| AppError::new("detached_head", "No branch."))?;
                    receipt.commit = Some(g.commit_snapshot(
                        r,
                        snapshot,
                        plan.expected.local_head.as_deref(),
                        branch,
                        plan.commit_message.as_deref().unwrap_or(""),
                        &cancel,
                    )?);
                    receipt.phase = "committed".to_string();
                    self.journal.save(&mut receipt)?;
                } else {
                    let head = plan
                        .expected
                        .local_head
                        .clone()
                        .ok_or_else(|| AppError::new("git_unborn", "No commit to push."))?;
                    receipt.commit = Some(CommitOutcome {
                        before_head: Some(head.clone()),
                        after_head: head,
                        committed_paths: Vec::new(),
                        pushed: None,
                    });
                }
                if let Some(target) = &plan.expected.publication {
                    receipt.phase = "publishing".to_string();
                    self.journal.save(&mut receipt)?;
                    let source = receipt.commit.as_ref().unwrap().after_head.clone();
                    let pushed = g.push_approved(
                        r,
                        target,
                        &source,
                        plan.expected.remote_tip.as_deref(),
                        self.credential()?.as_deref(),
                        &cancel,
                    )?;
                    receipt.commit.as_mut().unwrap().pushed = Some(pushed);
                    self.journal.save(&mut receipt)?;
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                receipt.state = OperationState::Succeeded;
                receipt.phase = "complete".to_string();
            }
            Err(error) => {
                receipt.error_code = Some(error.code.to_string());
                receipt.state = if receipt.created_repository.is_some()
                    || receipt
                        .commit
                        .as_ref()
                        .map_or(false, |c| !c.committed_paths.is_empty())
                {
                    OperationState::Partial
                } else {
                    OperationState::Unknown
                };
            }
        }
        self.journal.save(&mut receipt).map_err(|_| AppError::new("receipt_persistence_failed", "An action may have completed but its final receipt could not be saved. Inspect local and remote state; do not replay."))?;
        self.plans.consume(id)?;
        Ok(receipt)
    }
    pub fn invalidate(&self) -> Result<(), AppError> {
        let _guard = self.mutation_guard()?;
        self.plans.invalidate_all()
    }
}

struct ActiveOperation<'a>(&'a Mutex<Option<String>>);
impl Drop for ActiveOperation<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}

fn repository_guard(
    service: &GitService,
    root: &Path,
) -> Result<(std::fs::File, std::fs::File), AppError> {
    use fs4::fs_std::FileExt;
    let canonical_root = std::fs::canonicalize(root)?;
    let root = canonical_root.as_path();
    let actions_lock = crate::actions::acquire_workspace_lock(root)?;
    let common = service.run(
        service.spec(root).arg("rev-parse").arg("--git-common-dir"),
        &CancelToken::new(),
    )?;
    let common = PathBuf::from(common.trim());
    let common = if common.is_absolute() {
        common
    } else {
        root.join(common)
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(common.join("secret-tunnel-mutation.lock"))?;
    match FileExt::try_lock_exclusive(&file) {
        Ok(true) => Ok((file, actions_lock)),
        _ => Err(AppError::new(
            "repository_busy",
            "Another Secret Tunnel operation owns this repository.",
        )),
    }
}

pub(super) fn content_digest(root: &Path, paths: &[String]) -> Result<String, AppError> {
    Ok(snapshot::capture(root, paths)?.digest)
}
fn validate_segment(value: &str, label: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 100
        || value.starts_with('-')
        || value.starts_with('.')
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(AppError::new(
            "invalid_repository",
            format!("Invalid GitHub {label}."),
        ));
    }
    Ok(value.to_string())
}
