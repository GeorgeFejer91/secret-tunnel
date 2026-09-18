//! Regression gates for the broker's request surface.
//!
//! These exist because a live MCP call to `github_repo_ensure` was answered by
//! `unknown_route`: the tool was advertised while the running broker had no
//! such route. A route the MCP client can reach must therefore be reachable
//! here, and the two fields the website workflow depends on — repository
//! visibility and the Pages custom domain — must arrive at the coordinator
//! rather than being dropped or silently defaulted.
//!
//! No network, no Git, no GitHub. The coordinator is built over a disposable
//! profile with no workspace selected, so every recognised route fails on the
//! workspace instead of on the routing table, which is exactly the distinction
//! under test.
use super::broker::route;
use super::coordinator::GitHubCoordinator;
use crate::settings::AppPaths;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

struct Profile(PathBuf);
impl Profile {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("st-broker-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn coordinator(profile: &Profile) -> GitHubCoordinator {
    GitHubCoordinator::new(AppPaths {
        config_dir: profile.0.clone(),
        settings_path: profile.0.join("settings.json"),
        managed_config_path: profile.0.join("gpt-repo-mcp.config.json"),
        diagnostics_path: profile.0.join("diagnostics.log"),
    })
}

/// The refusal code for a request, or "ok" when it somehow succeeded.
fn code(path: &str, input: Value) -> String {
    let profile = Profile::new();
    match route(path, &input, &coordinator(&profile)) {
        Ok(_) => "ok".to_string(),
        Err(error) => error.code.to_string(),
    }
}

#[test]
fn every_route_the_mcp_client_may_call_is_routable() {
    // Exactly the set in github-broker-client.mjs. A route missing here is the
    // `unknown_route` failure the MCP surface cannot detect on its own.
    for (path, input) in [
        ("/runtime/status", json!({})),
        ("/github/status", json!({})),
        ("/github/plan", json!({ "action": "commit" })),
        ("/github/apply", json!({ "planId": "plan-x" })),
        ("/github/create_repository", json!({ "name": "fixture" })),
        (
            "/github/create_repository/apply",
            json!({ "planId": "plan-x" }),
        ),
        ("/github/operation_status", json!({ "planId": "plan-x" })),
        ("/github/pages_context", json!({})),
        ("/github/repo_ensure", json!({ "name": "fixture" })),
        (
            "/github/repo_ship",
            json!({ "paths": ["a.txt"], "message": "m" }),
        ),
        ("/github/pages_ensure", json!({})),
        ("/github/direct_credential", json!({})),
    ] {
        assert_ne!(code(path, input), "unknown_route", "{path} is not routed");
    }
}

/// The direct path gets a credential only from a connection this app owns.
///
/// A disposable profile has no stored account, so the only way this could
/// succeed is by lending out a credential found on the machine - which was
/// granted to the user's Git credential manager and is not ours to hand to
/// anything, least of all a process reachable through a public tunnel.
#[test]
fn the_direct_credential_route_refuses_without_our_own_connection() {
    assert_ne!(
        code("/github/direct_credential", json!({})),
        "ok",
        "an unconnected profile must not yield a credential"
    );
}

#[test]
fn an_unlisted_route_is_still_refused() {
    assert_eq!(
        code("/github/delete_repository", json!({})),
        "unknown_route"
    );
    assert_eq!(
        code("/github/repo_ensure/apply", json!({})),
        "unknown_route"
    );
}

#[test]
fn repo_ensure_accepts_an_explicit_visibility_and_nothing_else() {
    // Reaching the coordinator (which refuses because the disposable profile has
    // the feature off) means the field was accepted and parsed here.
    for visibility in ["public", "private"] {
        assert_eq!(
            code(
                "/github/repo_ensure",
                json!({ "name": "fixture", "visibility": visibility }),
            ),
            "github_disabled",
        );
    }
    assert_eq!(
        code("/github/repo_ensure", json!({ "name": "fixture" })),
        "github_disabled"
    );
    for rejected in [json!("internal"), json!(true), json!(["public"])] {
        assert_eq!(
            code(
                "/github/repo_ensure",
                json!({ "name": "fixture", "visibility": rejected }),
            ),
            "invalid_input",
        );
    }
    assert_eq!(
        code(
            "/github/repo_ensure",
            json!({ "name": "fixture", "private": false })
        ),
        "invalid_input",
    );
}

#[test]
fn pages_ensure_accepts_a_custom_domain_and_https_only_with_one() {
    assert_eq!(code("/github/pages_ensure", json!({})), "github_disabled");
    assert_eq!(
        code(
            "/github/pages_ensure",
            json!({ "domain": "example.com", "httpsEnforced": true }),
        ),
        "github_disabled",
    );
    // HTTPS without a domain would silently do nothing, so it is refused.
    assert_eq!(
        code("/github/pages_ensure", json!({ "httpsEnforced": true })),
        "invalid_input",
    );
    for rejected in [json!(42), json!(true), json!(["example.com"])] {
        assert_eq!(
            code("/github/pages_ensure", json!({ "domain": rejected })),
            "invalid_input",
        );
    }
    assert_eq!(
        code("/github/pages_ensure", json!({ "cname": "example.com" })),
        "invalid_input",
    );
}

#[test]
fn a_custom_domain_must_be_a_plain_hostname() {
    use super::account::validate_pages_domain;
    assert!(validate_pages_domain("creations-of-ra.com").is_ok());
    assert!(validate_pages_domain("a.b.example.com").is_ok());
    for rejected in [
        "example",
        "https://example.com",
        "example.com/path",
        "Example.com",
        "-example.com",
        "example.com.",
        "example..com",
        "exa mple.com",
        "example.com?x=1",
    ] {
        assert!(
            validate_pages_domain(rejected).is_err(),
            "{rejected} should be refused",
        );
    }
}
