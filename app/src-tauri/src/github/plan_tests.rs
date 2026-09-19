//! T20 - plan, approval and staleness (For-AI/PLANNER/github-sync/TEST_PLAN.md).
//!
//! The property under test throughout: a caller can describe what it wants, but
//! only the desktop user can authorise it, and only against the exact state the
//! plan was built for.

use super::plan::{build_plan, now_secs, ExpectedState, PlanAction, PlanStore, PLAN_TTL};

fn expected() -> ExpectedState {
    ExpectedState {
        workspace_fingerprint: "fp-workspace".to_string(),
        settings_revision: 42,
        publication: None,
        account_login: None,
        local_head: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()),
        branch: Some("main".to_string()),
        remote_tip: Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string()),
        content_digest: Some("cccccccccccccccccccccccccccccccc".to_string()),
    }
}

fn store_with_plan(action: PlanAction) -> (PlanStore, super::plan::Plan) {
    let store = PlanStore::new();
    let plan = store
        .insert(build_plan(
            action,
            "octocat/hello-world".to_string(),
            expected(),
            vec!["index.html".to_string()],
            Some("update the page".to_string()),
            Vec::new(),
        ))
        .unwrap();
    (store, plan)
}

/// The central guarantee. An unapproved plan cannot be applied, no matter what
/// the caller claims: approval lives in desktop-owned storage keyed by plan id,
/// and there is no parameter that can stand in for it.
#[test]
fn t20_an_unapproved_plan_is_refused() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);

    let error = store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap_err();
    assert_eq!(error.code, "plan_not_approved");
}

/// Autonomous mode is the authorisation: an unapproved plan runs. This is the
/// single behavioural difference between the two modes.
#[test]
fn autonomous_mode_authorizes_without_a_desktop_approval() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);

    // The same plan is refused under local approval.
    assert_eq!(
        store
            .authorize(
                &plan.id,
                &expected(),
                now_secs(),
                crate::settings::ApprovalMode::Local
            )
            .unwrap_err()
            .code,
        "plan_not_approved"
    );

    let authorized = store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Autonomous,
        )
        .unwrap();
    assert_eq!(authorized.id, plan.id);
}

/// Autonomy removes the approval requirement and nothing else: a plan whose
/// world moved underneath it is still refused.
#[test]
fn autonomous_mode_still_refuses_a_stale_plan() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);

    let mut moved = expected();
    moved.local_head = Some("f".repeat(40));

    let error = store
        .authorize(
            &plan.id,
            &moved,
            now_secs(),
            crate::settings::ApprovalMode::Autonomous,
        )
        .unwrap_err();
    assert_eq!(error.code, "local_head_moved");
}

#[test]
fn t20_an_approved_plan_applies_against_unchanged_state() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);
    store.approve(&plan.id, now_secs()).unwrap();

    let authorized = store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap();
    assert_eq!(authorized.id, plan.id);
    assert_eq!(authorized.paths, vec!["index.html".to_string()]);
}

/// Approval is bound to the plan's contents, not merely its id. A plan that is
/// altered after approval must require approving again.
#[test]
fn t20_approval_does_not_transfer_to_a_modified_plan() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);
    store.approve(&plan.id, now_secs()).unwrap();

    // Same id, different content: a caller trying to widen the path list or
    // change the message after the user approved it.
    let mut tampered = plan.clone();
    tampered.paths = vec!["index.html".to_string(), "secrets.env".to_string()];
    store.insert(tampered).unwrap();

    let error = store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap_err();
    assert_eq!(error.code, "plan_approval_mismatch");
}

#[test]
fn t20_unknown_plan_is_refused() {
    let store = PlanStore::new();
    let error = store
        .authorize(
            "plan-does-not-exist",
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap_err();
    assert_eq!(error.code, "plan_unknown");
}

#[test]
fn t20_expired_plan_is_refused_even_when_approved() {
    let (store, plan) = store_with_plan(PlanAction::Commit);
    store.approve(&plan.id, now_secs()).unwrap();

    let after_expiry = now_secs() + PLAN_TTL.as_secs() + 1;
    let error = store
        .authorize(
            &plan.id,
            &expected(),
            after_expiry,
            crate::settings::ApprovalMode::Local,
        )
        .unwrap_err();
    assert_eq!(error.code, "plan_expired");
}

/// Each of these is a way the world can move between planning and applying.
/// Every one must be caught, because the plan described the old world.
#[test]
fn t20_state_drift_is_refused_field_by_field() {
    let cases: Vec<(&str, fn(&mut ExpectedState))> = vec![
        ("workspace_changed", |state| {
            state.workspace_fingerprint = "fp-other-folder".to_string()
        }),
        ("settings_changed", |state| state.settings_revision = 43),
        ("local_head_moved", |state| {
            state.local_head = Some("cccccccccccccccccccccccccccccccccccccccc".to_string())
        }),
        ("branch_changed", |state| {
            state.branch = Some("release".to_string())
        }),
        ("remote_moved", |state| {
            state.remote_tip = Some("dddddddddddddddddddddddddddddddddddddddd".to_string())
        }),
    ];

    for (expected_code, mutate) in cases {
        let (store, plan) = store_with_plan(PlanAction::CommitPush);
        store.approve(&plan.id, now_secs()).unwrap();

        let mut observed = expected();
        mutate(&mut observed);

        let error = store
            .authorize(
                &plan.id,
                &observed,
                now_secs(),
                crate::settings::ApprovalMode::Local,
            )
            .unwrap_err();
        assert_eq!(
            error.code, expected_code,
            "drift in {expected_code} should be refused"
        );
    }
}

/// A purely local commit does not depend on the remote, so a remote that moved
/// must not block it. Being precise here is what keeps the staleness checks
/// credible rather than something users learn to work around.
#[test]
fn t20_local_commit_ignores_remote_movement() {
    let (store, plan) = store_with_plan(PlanAction::Commit);
    store.approve(&plan.id, now_secs()).unwrap();

    let mut observed = expected();
    observed.remote_tip = Some("dddddddddddddddddddddddddddddddddddddddd".to_string());

    assert!(store
        .authorize(
            &plan.id,
            &observed,
            now_secs(),
            crate::settings::ApprovalMode::Local
        )
        .is_ok());
}

/// Applying twice must not be possible: the second attempt finds nothing.
#[test]
fn t20_a_consumed_plan_cannot_be_replayed() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);
    store.approve(&plan.id, now_secs()).unwrap();
    store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap();

    store.consume(&plan.id).unwrap();

    let error = store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap_err();
    assert_eq!(error.code, "plan_unknown");
}

/// Changing folder, binding or account invalidates everything outstanding.
#[test]
fn t20_invalidate_all_clears_plans_and_approvals() {
    let (store, plan) = store_with_plan(PlanAction::CommitPush);
    store.approve(&plan.id, now_secs()).unwrap();

    store.invalidate_all().unwrap();

    assert!(store.get(&plan.id).unwrap().is_none());
    let error = store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .unwrap_err();
    assert_eq!(error.code, "plan_unknown");
}

#[test]
fn t20_cancel_removes_a_pending_plan() {
    let (store, plan) = store_with_plan(PlanAction::Commit);
    assert_eq!(store.pending(now_secs()).unwrap().len(), 1);

    store.cancel(&plan.id).unwrap();

    assert!(store.pending(now_secs()).unwrap().is_empty());
}

/// Approved plans drop off the pending list, which is what the desktop shows.
#[test]
fn t20_pending_excludes_approved_and_expired_plans() {
    let (store, plan) = store_with_plan(PlanAction::Commit);
    assert_eq!(store.pending(now_secs()).unwrap().len(), 1);

    store.approve(&plan.id, now_secs()).unwrap();
    assert!(store.pending(now_secs()).unwrap().is_empty());

    let (store2, _plan2) = store_with_plan(PlanAction::Commit);
    let after_expiry = now_secs() + PLAN_TTL.as_secs() + 1;
    assert!(store2.pending(after_expiry).unwrap().is_empty());
}

/// Plan ids must not be guessable, or one could be approved by accident.
#[test]
fn t20_plan_ids_are_unique_and_unguessable() {
    let (_store, first) = store_with_plan(PlanAction::Commit);
    let (_store2, second) = store_with_plan(PlanAction::Commit);

    assert_ne!(first.id, second.id);
    assert!(first.id.starts_with("plan-"));
    assert!(first.id.len() > 20, "id should carry real entropy");
}

/// The approval UI must be able to say plainly whether anything leaves the
/// machine, since that is the part a user cannot quietly undo.
#[test]
fn t20_actions_declare_whether_they_publish() {
    assert!(!PlanAction::Commit.touches_remote());
    assert!(PlanAction::CommitPush.touches_remote());
    assert!(PlanAction::Push.touches_remote());
}

/// The window this closes: a plan is approved, and then the bytes on disk are
/// replaced before apply. Every field describing the repository's *position* is
/// untouched - same HEAD, same branch, same folder, same settings - so without a
/// content binding this apply would be authorised and would commit bytes the
/// user never saw, under the message they did approve.
#[test]
fn t20_content_changed_after_approval_is_refused() {
    let (store, plan) = store_with_plan(PlanAction::Commit);
    store.approve(&plan.id, now_secs()).unwrap();

    // Approving against the world as it was must of course still work.
    store
        .authorize(
            &plan.id,
            &expected(),
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .expect("an approved plan against unchanged state applies");

    let mut rewritten = expected();
    rewritten.content_digest = Some("dddddddddddddddddddddddddddddddd".to_string());
    let error = store
        .authorize(
            &plan.id,
            &rewritten,
            now_secs(),
            crate::settings::ApprovalMode::Local,
        )
        .expect_err("the same plan must not apply once the files have changed");
    assert_eq!(error.code, "content_changed");
}

/// The digest is bound into the hash the approval is recorded against, not only
/// compared at apply time. A plan whose content digest differs is a different
/// plan, so an approval cannot be carried across to it.
#[test]
fn t20_the_content_digest_is_part_of_the_approved_identity() {
    let (_, plan) = store_with_plan(PlanAction::Commit);
    let mut other = plan.clone();
    other.expected.content_digest = Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string());
    assert_ne!(
        plan.content_hash(),
        other.content_hash(),
        "changing the planned content must change the plan's identity"
    );
}

/// Reading a plan's paths is a prerequisite of applying it, so it must not be a
/// way to learn about plans that do not exist.
#[test]
fn t20_planned_paths_returns_the_plan_paths_and_refuses_unknown_ids() {
    let (store, plan) = store_with_plan(PlanAction::Commit);
    assert_eq!(
        store.planned_paths(&plan.id).unwrap(),
        vec!["index.html".to_string()]
    );
    let error = store.planned_paths("plan-does-not-exist").unwrap_err();
    assert_eq!(error.code, "plan_unknown");
}
