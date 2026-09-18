//! Immutable plans, local approvals, and staleness checks.
//!
//! The rule this module exists to enforce: **ChatGPT can propose a mutation but
//! cannot authorise one.** A plan is a description of exactly what would happen,
//! captured against the state that existed when it was made. Approval is a
//! separate record created only by the desktop user. Apply re-derives the state
//! and refuses if anything moved.
//!
//! A model supplying `{"approved": true}` therefore achieves nothing: approval
//! is looked up by plan id in storage the model cannot write to, and the stored
//! record is matched against a hash of the plan's own contents.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long an unapproved plan stays valid. Long enough to read and decide,
/// short enough that an abandoned plan cannot be approved much later against a
/// repository that has since moved on.
pub const PLAN_TTL: Duration = Duration::from_secs(15 * 60);

/// The mutations the beta can plan. The enum is closed: an action that is not
/// listed cannot be requested, so an unimplemented verb fails at the schema
/// rather than reaching the executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanAction {
    Commit,
    CommitPush,
    Push,
    /// Create a private repository only. Initializing a folder or replacing a
    /// remote is a separate desktop action and is never an implicit side effect.
    CreateRepository,
}

impl PlanAction {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanAction::Commit => "commit",
            PlanAction::CommitPush => "commit_push",
            PlanAction::Push => "push",
            PlanAction::CreateRepository => "create_repository",
        }
    }

    /// Whether carrying this out changes anything outside the local machine.
    /// The approval UI says so explicitly, because publishing is the step a
    /// user cannot quietly undo.
    pub fn touches_remote(self) -> bool {
        matches!(
            self,
            PlanAction::CommitPush | PlanAction::Push | PlanAction::CreateRepository
        )
    }
}

/// The exact state a plan was built against. Apply re-derives every field and
/// compares; any difference means the world moved and the plan is stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedState {
    /// Canonical identity of the selected folder.
    pub workspace_fingerprint: String,
    /// Settings revision, so a binding or feature change invalidates the plan.
    pub settings_revision: u64,
    /// Local HEAD when the plan was made. `None` for an unborn repository.
    pub local_head: Option<String>,
    pub branch: Option<String>,
    /// Remote tip when the plan was made, where the action touches a remote.
    pub remote_tip: Option<String>,
    /// Digest of the exact bytes of the planned paths as they were when the
    /// plan was made.
    ///
    /// Without this the approval would bind only the repository's position -
    /// HEAD, branch, settings - and none of those move when a file's contents
    /// change in the worktree. A model that can write to the selected folder
    /// could therefore propose a change, let the user read and approve it, then
    /// overwrite the bytes before apply and have its own content committed
    /// under the approved message. Binding the content closes that window: the
    /// bytes that are committed are the bytes that were reviewed, or the apply
    /// is refused.
    ///
    /// `None` only for plans that stage nothing.
    #[serde(default)]
    pub content_digest: Option<String>,
    /// Effective publication destination, derived locally, never supplied by MCP.
    #[serde(default)]
    pub publication: Option<super::publication::PublicationTarget>,
    /// Verified account identity for repository creation.
    #[serde(default)]
    pub account_login: Option<String>,
}

/// An immutable description of a proposed mutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub action: PlanAction,
    pub repository: String,
    pub expected: ExpectedState,
    /// Exactly the paths that will be staged and committed. Nothing else is.
    pub paths: Vec<String>,
    pub commit_message: Option<String>,
    pub created_at_secs: u64,
    pub expires_at_secs: u64,
    /// Things the user should see before approving, in plain words.
    pub warnings: Vec<String>,
}

impl Plan {
    pub fn is_expired(&self, now_secs: u64) -> bool {
        now_secs >= self.expires_at_secs
    }

    /// Content hash binding an approval to this exact plan. Changing any field
    /// changes the hash, so an approval cannot be transplanted onto a different
    /// plan that reuses the id.
    pub fn content_hash(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(self.id.as_bytes());
        hasher.update(self.action.as_str().as_bytes());
        hasher.update(self.repository.as_bytes());
        hasher.update(self.expected.workspace_fingerprint.as_bytes());
        hasher.update(self.expected.settings_revision.to_le_bytes());
        hasher.update(
            self.expected
                .local_head
                .clone()
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher.update(self.expected.branch.clone().unwrap_or_default().as_bytes());
        hasher.update(
            self.expected
                .remote_tip
                .clone()
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher.update(
            self.expected
                .content_digest
                .clone()
                .unwrap_or_default()
                .as_bytes(),
        );
        for path in &self.paths {
            hasher.update(path.as_bytes());
            hasher.update([0]);
        }
        hasher.update(self.commit_message.clone().unwrap_or_default().as_bytes());
        hasher.update(self.expires_at_secs.to_le_bytes());
        // Canonical serde field ordering; bind new fields without ambiguous concatenation.
        hasher.update(serde_json::to_vec(&self.expected).unwrap_or_default());
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// Proof that the desktop user approved one specific plan.
///
/// Created only by the desktop coordinator. It stores the plan's content hash,
/// so approving a plan and then altering it invalidates the approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub plan_id: String,
    pub plan_hash: String,
    pub approved_at_secs: u64,
    pub expires_at_secs: u64,
}

/// Why an apply was refused. Each variant is a distinct thing the user may need
/// to do, rather than one opaque failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaleReason {
    UnknownPlan,
    Expired,
    NotApproved,
    ApprovalMismatch,
    WorkspaceChanged,
    SettingsChanged,
    LocalHeadMoved,
    BranchChanged,
    RemoteMoved,
    ContentChanged,
}

impl StaleReason {
    pub fn code(&self) -> &'static str {
        match self {
            StaleReason::UnknownPlan => "plan_unknown",
            StaleReason::Expired => "plan_expired",
            StaleReason::NotApproved => "plan_not_approved",
            StaleReason::ApprovalMismatch => "plan_approval_mismatch",
            StaleReason::WorkspaceChanged => "workspace_changed",
            StaleReason::SettingsChanged => "settings_changed",
            StaleReason::LocalHeadMoved => "local_head_moved",
            StaleReason::BranchChanged => "branch_changed",
            StaleReason::RemoteMoved => "remote_moved",
            StaleReason::ContentChanged => "content_changed",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            StaleReason::UnknownPlan => "That plan does not exist. Create a new one.",
            StaleReason::Expired => "That plan expired. Create a new one.",
            StaleReason::NotApproved => {
                "That plan has not been approved in the Secret Tunnel window yet."
            }
            StaleReason::ApprovalMismatch => {
                "The plan changed after it was approved. Review and approve it again."
            }
            StaleReason::WorkspaceChanged => "The selected folder changed after the plan was made.",
            StaleReason::SettingsChanged => {
                "The repository binding or settings changed after the plan was made."
            }
            StaleReason::LocalHeadMoved => {
                "The repository received new commits after the plan was made."
            }
            StaleReason::BranchChanged => "The branch changed after the plan was made.",
            StaleReason::RemoteMoved => {
                "The remote branch moved after the plan was made. Fetch and plan again."
            }
            StaleReason::ContentChanged => {
                "The files changed after this plan was reviewed. Nothing was committed.                  Plan again so you approve the bytes that would actually be committed."
            }
        }
    }

    pub fn to_error(&self) -> AppError {
        AppError::new(self.code(), self.message())
    }
}

/// Plans and approvals, held in the desktop process.
///
/// Storage lives with the coordinator, not in the shared workspace: a file
/// inside the folder being exposed would be writable through the very MCP
/// connection whose requests it is supposed to authorise.
#[derive(Clone, Default)]
pub struct PlanStore {
    inner: Arc<Mutex<PlanStoreState>>,
}

#[derive(Default)]
struct PlanStoreState {
    plans: HashMap<String, Plan>,
    approvals: HashMap<String, Approval>,
    claimed: HashSet<String>,
}

impl PlanStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a new plan. Creating a plan never mutates the repository.
    pub fn insert(&self, plan: Plan) -> Result<Plan, AppError> {
        let mut state = self.lock()?;
        state
            .plans
            .retain(|_, existing| !existing.is_expired(now_secs()));
        let valid_ids: HashSet<String> = state.plans.keys().cloned().collect();
        state.approvals.retain(|id, _| valid_ids.contains(id));
        state.plans.insert(plan.id.clone(), plan.clone());
        if state.plans.len() > 5 {
            state.plans.remove(&plan.id);
            return Err(AppError::new(
                "plan_store_full",
                "At most five live plans may be buffered; finish or cancel an existing plan.",
            ));
        }
        Ok(plan)
    }

    pub fn get(&self, plan_id: &str) -> Result<Option<Plan>, AppError> {
        Ok(self.lock()?.plans.get(plan_id).cloned())
    }

    pub fn pending(&self, now_secs: u64) -> Result<Vec<Plan>, AppError> {
        let state = self.lock()?;
        let mut plans: Vec<Plan> = state
            .plans
            .values()
            .filter(|plan| !plan.is_expired(now_secs) && !state.approvals.contains_key(&plan.id))
            .cloned()
            .collect();
        plans.sort_by_key(|plan| plan.created_at_secs);
        Ok(plans)
    }

    pub fn approved(&self, now_secs: u64) -> Result<Vec<Plan>, AppError> {
        let state = self.lock()?;
        Ok(state
            .plans
            .values()
            .filter(|p| {
                !p.is_expired(now_secs)
                    && state.approvals.contains_key(&p.id)
                    && !state.claimed.contains(&p.id)
            })
            .cloned()
            .collect())
    }

    /// Claim exactly once. Coordinator serializes observation/authorization/claim;
    /// the durable journal is created exclusively before the first side effect.
    pub fn claim(
        &self,
        plan_id: &str,
        mode: crate::settings::ApprovalMode,
    ) -> Result<(), AppError> {
        let mut state = self.lock()?;
        // Autonomous mode records no approval, so requiring one here would
        // refuse every plan `authorize` has already cleared.
        let authorised = mode.is_autonomous() || state.approvals.contains_key(plan_id);
        if !state.plans.contains_key(plan_id) || !authorised {
            return Err(StaleReason::NotApproved.to_error());
        }
        if !state.claimed.insert(plan_id.to_string()) {
            return Err(AppError::new(
                "operation_already_claimed",
                "Read the existing operation; do not execute it again.",
            ));
        }
        Ok(())
    }

    /// Approve a plan. Only the desktop calls this.
    pub fn approve(&self, plan_id: &str, now_secs: u64) -> Result<Approval, AppError> {
        let mut state = self.lock()?;
        let plan = state
            .plans
            .get(plan_id)
            .cloned()
            .ok_or_else(|| StaleReason::UnknownPlan.to_error())?;
        if plan.is_expired(now_secs) {
            return Err(StaleReason::Expired.to_error());
        }
        if state.claimed.contains(plan_id) {
            return Err(AppError::new(
                "operation_already_claimed",
                "This operation was already started.",
            ));
        }
        let approval = Approval {
            plan_id: plan.id.clone(),
            plan_hash: plan.content_hash(),
            approved_at_secs: now_secs,
            expires_at_secs: plan.expires_at_secs,
        };
        state.approvals.insert(plan.id.clone(), approval.clone());
        Ok(approval)
    }

    /// Withdraw an approval and the plan itself.
    pub fn cancel(&self, plan_id: &str) -> Result<(), AppError> {
        let mut state = self.lock()?;
        // Consuming removes the plan; the durable receipt remains authoritative.
        state.plans.remove(plan_id);
        state.approvals.remove(plan_id);
        Ok(())
    }

    /// Drop every plan and approval. Called when the selected folder, binding
    /// or account changes, since all of them were bound to the old state.
    pub fn invalidate_all(&self) -> Result<(), AppError> {
        let mut state = self.lock()?;
        state.plans.clear();
        state.approvals.clear();
        // Claimed IDs remain spent for this process even after settings change.
        Ok(())
    }

    /// Check that a plan may be applied right now.
    ///
    /// The paths a plan would stage, without authorising anything.
    ///
    /// Apply needs these before it can authorise, because the content digest it
    /// must compare is a digest *of* these paths. Returning them is safe: they
    /// are the caller's own proposal read back, and nothing here grants
    /// permission to act on them.
    pub fn planned_paths(&self, plan_id: &str) -> Result<Vec<String>, AppError> {
        let state = self.lock()?;
        state
            .plans
            .get(plan_id)
            .map(|plan| plan.paths.clone())
            .ok_or_else(|| StaleReason::UnknownPlan.to_error())
    }

    /// `observed` is state re-derived at apply time, never supplied by the
    /// caller. Returns the plan only when everything still matches.
    pub fn authorize(
        &self,
        plan_id: &str,
        observed: &ExpectedState,
        now_secs: u64,
        mode: crate::settings::ApprovalMode,
    ) -> Result<Plan, AppError> {
        let state = self.lock()?;
        let plan = state
            .plans
            .get(plan_id)
            .cloned()
            .ok_or_else(|| StaleReason::UnknownPlan.to_error())?;

        if plan.is_expired(now_secs) {
            return Err(StaleReason::Expired.to_error());
        }

        // The only thing autonomous mode changes: whether a recorded desktop
        // approval is required. Every staleness check above and below still runs.
        if !mode.is_autonomous() {
            let approval = state
                .approvals
                .get(plan_id)
                .ok_or_else(|| StaleReason::NotApproved.to_error())?;
            if approval.plan_hash != plan.content_hash() {
                return Err(StaleReason::ApprovalMismatch.to_error());
            }
            if now_secs >= approval.expires_at_secs {
                return Err(StaleReason::Expired.to_error());
            }
        }

        if observed.workspace_fingerprint != plan.expected.workspace_fingerprint {
            return Err(StaleReason::WorkspaceChanged.to_error());
        }
        if observed.settings_revision != plan.expected.settings_revision {
            return Err(StaleReason::SettingsChanged.to_error());
        }
        if observed.local_head != plan.expected.local_head {
            return Err(StaleReason::LocalHeadMoved.to_error());
        }
        if observed.branch != plan.expected.branch {
            return Err(StaleReason::BranchChanged.to_error());
        }
        if state.claimed.contains(plan_id) {
            return Err(AppError::new(
                "operation_already_claimed",
                "Read the existing operation receipt.",
            ));
        }
        if observed.publication != plan.expected.publication {
            return Err(AppError::new(
                "publication_changed",
                "The effective push destination changed. Review a new plan.",
            ));
        }
        if observed.account_login != plan.expected.account_login {
            return Err(AppError::new(
                "account_changed",
                "The connected account changed. Review a new plan.",
            ));
        }
        // Only meaningful for actions that publish; a local commit does not
        // care what the remote is doing.
        if plan.action.touches_remote() && observed.remote_tip != plan.expected.remote_tip {
            return Err(StaleReason::RemoteMoved.to_error());
        }
        // Checked last because it is the expensive one to produce, and because
        // a caller who moved HEAD as well should hear about that first.
        if observed.content_digest != plan.expected.content_digest {
            return Err(StaleReason::ContentChanged.to_error());
        }

        Ok(plan)
    }

    /// Mark a plan as carried out so it cannot be applied twice.
    pub fn consume(&self, plan_id: &str) -> Result<(), AppError> {
        self.cancel(plan_id)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, PlanStoreState>, AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::new("plan_store_unavailable", "Plan storage is unavailable."))
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Build a plan. Deliberately the only constructor, so every plan carries an
/// expiry and a random id rather than one a caller chose.
pub fn build_plan(
    action: PlanAction,
    repository: String,
    expected: ExpectedState,
    paths: Vec<String>,
    commit_message: Option<String>,
    warnings: Vec<String>,
) -> Plan {
    let created = now_secs();
    Plan {
        id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
        action,
        repository,
        expected,
        paths,
        commit_message,
        created_at_secs: created,
        expires_at_secs: created + PLAN_TTL.as_secs(),
        warnings,
    }
}
