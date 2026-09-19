//! GitHub account connection over the OAuth device flow.
//!
//! The desktop never handles the user's GitHub password. The button opens the
//! browser at GitHub's own verification page; GitHub authenticates the user and
//! returns a token to this process only after the user approves the short code.
//!
//! Device flow is used rather than a loopback redirect because an OAuth App's
//! token exchange requires a client secret, and a secret embedded in a desktop
//! binary is extractable by anyone who has the binary. Device flow needs no
//! secret. The client id below is public by design and is not a credential.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const USER_AGENT: &str = "SecretTunnel-v3";

/// Everything the advertised GitHub feature set needs, asked for once.
///
/// `repo` covers creating repositories, reading and writing their contents,
/// pushing over HTTPS, and administering GitHub Pages including its custom
/// domain. `workflow` is separate on purpose: without it GitHub refuses any
/// push whose commit adds or changes a file under `.github/workflows/`, which
/// is exactly what `ensure_pages` writes. Deliberately excludes `delete_repo`:
/// deletion through an automated path is not recoverable.
const SCOPE: &str = "repo workflow";

/// Where the user registers the OAuth App this installation signs in to.
///
/// GitHub prefills the registration form from these query parameters, so the
/// user only has to press Register and then tick Enable Device Flow. The
/// callback URL is required by the form and unused by device flow.
pub const REGISTRATION_URL: &str = "https://github.com/settings/applications/new?oauth_application%5Bname%5D=Secret%20Tunnel%20v3&oauth_application%5Burl%5D=https%3A%2F%2Fgithub.com%2FGeorgeFejer91%2FSecretTunnel-v2&oauth_application%5Bcallback_url%5D=http%3A%2F%2F127.0.0.1%2Fsecret-tunnel%2Funused";

/// Public OAuth App identifier, not a secret: it ships in every copy of the
/// binary and GitHub treats it as public. Because it is compiled in, someone
/// who downloads Secret Tunnel registers nothing - they press Connect GitHub,
/// approve the code GitHub shows them, and are done.
const CLIENT_ID: &str = "Ov23liL29bL0ZqF73KPk";

/// Which OAuth App this installation signs in to.
///
/// The compiled-in id is the product's own, and there is deliberately no
/// per-profile setting: one left behind by an earlier build would silently
/// send a released copy to somebody else's OAuth App. The environment
/// override remains so the flow can be pointed at a throwaway test app
/// without a rebuild, which is a developer action, not a user setting.
pub fn resolve_client_id() -> Result<String, AppError> {
    if let Some(value) = std::env::var_os("SECRET_TUNNEL_GITHUB_CLIENT_ID") {
        let value = value.to_string_lossy().trim().to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    if CLIENT_ID.is_empty() {
        return Err(AppError::new(
            "github_client_id_missing",
            "This build has no GitHub OAuth client id.",
        ));
    }
    Ok(CLIENT_ID.to_string())
}

/// What the desktop shows the user while the browser is open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    /// The verification page with the code already filled in.
    ///
    /// This is what the desktop actually opens, so the user approves a page
    /// that already knows which device is asking instead of transcribing a
    /// code by hand. `user_code` is still shown, because the browser may fail
    /// to open and because GitHub asks the user to confirm the code matches.
    pub verification_uri_complete: String,
    pub device_code: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

/// One poll of the token endpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PollOutcome {
    /// The user has not finished approving yet.
    Pending,
    /// GitHub asked us to back off; the caller waits longer before retrying.
    SlowDown {
        interval_secs: u64,
    },
    Connected {
        login: String,
    },
    Denied,
    Expired,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub connected: bool,
    pub login: Option<String>,
    pub scope: Option<String>,
    /// Whether this connection authorises GitHub operations without a desktop
    /// click. Filled by the command layer, which is where settings are read.
    #[serde(default)]
    pub autonomous: bool,
    /// Which credential identifies this account, so the window can say so
    /// instead of implying this app was granted its own.
    pub source: Option<TokenSource>,
    pub storage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
    token: String,
    login: String,
    scope: String,
}

fn account_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join("github-account.json")
}

/// The token lives beside the other per-user configuration, which on Windows is
/// already restricted to this user by the profile ACL.
//
// New Windows writes are user-scoped DPAPI envelopes. Legacy plaintext reads
// remain compatible and are explicitly reported as unencrypted. Non-Windows
// private files are mode 0600, not OS-encrypted. Same-user malware is not sandboxed.
fn write_account(config_dir: &Path, account: &StoredAccount) -> Result<(), AppError> {
    fs::create_dir_all(config_dir)?;
    let path = account_path(config_dir);
    let protected = super::credential_store::encode(&serde_json::to_vec(account)?)?;
    let temporary = config_dir.join(format!(
        "account-write-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), AppError> {
        let mut file = options.open(&temporary)?;
        file.write_all(&protected)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_account(config_dir: &Path) -> Option<StoredAccount> {
    let path = account_path(config_dir);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 128 * 1024 {
        return None;
    }
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(&super::credential_store::decode(&raw).ok()?).ok()
}

/// What this application itself was granted. Pure: no network, no Git.
pub fn stored_state(config_dir: &Path) -> AccountState {
    match read_account(config_dir) {
        Some(account) => AccountState {
            connected: true,
            login: Some(account.login),
            scope: Some(account.scope),
            source: Some(TokenSource::ConnectedAccount),
            storage: fs::read(account_path(config_dir))
                .ok()
                .map(|b| super::credential_store::storage_kind(&b).to_string()),
            ..AccountState::default()
        },
        None => AccountState::default(),
    }
}

/// What the window should show. Prefers this application's own grant and
/// falls back to the credential Git already holds, which costs one request
/// to GitHub, so this is called on demand rather than on a poll.
pub fn state(config_dir: &Path) -> AccountState {
    let stored = stored_state(config_dir);
    if stored.connected {
        return stored;
    }

    // No account of our own. The same credential the push path already uses
    // may still identify the user, so report that rather than claiming there
    // is no GitHub access when there demonstrably is. It is labelled as
    // borrowed, because it was granted to their Git credential manager and
    // not to this application.
    match git_credential_token().and_then(|token| fetch_login(&token).ok()) {
        Some(login) => AccountState {
            connected: true,
            login: Some(login),
            scope: None,
            source: Some(TokenSource::GitCredentialHelper),
            storage: Some("system_helper_managed".to_string()),
            ..AccountState::default()
        },
        None => AccountState::default(),
    }
}

/// Upgrade legacy Windows plaintext once during desktop startup, never during a
/// public status read. No account login or network request is performed.
pub fn upgrade_local_storage(config_dir: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        let path = account_path(config_dir);
        if !path.exists() {
            return Ok(());
        }
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 128 * 1024 {
            return Err(AppError::new(
                "account_store_unsafe",
                "Account storage is not a bounded regular file.",
            ));
        }
        let raw = fs::read(&path)?;
        if super::credential_store::storage_kind(&raw) != "windows_dpapi" {
            let account = read_account(config_dir).ok_or_else(|| {
                AppError::new(
                    "account_store_unreadable",
                    "The legacy account record cannot be read.",
                )
            })?;
            write_account(config_dir, &account)?;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = config_dir;
    }
    Ok(())
}

/// Desktop-only export for an explicitly requested encrypted settings transfer.
/// Never borrows a Git credential-helper grant or copies a DPAPI envelope.
pub(crate) fn network_export_account(
    config_dir: &Path,
) -> Result<Option<serde_json::Value>, AppError> {
    let account = read_account(config_dir).ok_or_else(|| AppError::new(
        "network_account_missing", "Connect GitHub in Secret Tunnel before exporting its authorization. Credential-helper accounts are not exported."
    ))?;
    Ok(Some(serde_json::to_value(account)?))
}

/// Verify the transferred grant, then protect it under the destination user.
/// Existing authorizations are never silently replaced.
pub(crate) fn network_import_account(
    config_dir: &Path,
    value: serde_json::Value,
) -> Result<(), AppError> {
    if account_path(config_dir).exists() {
        return Err(AppError::new(
            "network_account_exists",
            "Disconnect this PC's existing Secret Tunnel GitHub account before importing another.",
        ));
    }
    let account: StoredAccount = serde_json::from_value(value)
        .map_err(|_| AppError::new("network_account_invalid", "Invalid transferred account."))?;
    if account.token.is_empty()
        || account.token.len() > 4096
        || account.login.len() > 128
        || account.scope.len() > 1024
    {
        return Err(AppError::new(
            "network_account_invalid",
            "Invalid transferred account.",
        ));
    }
    let verified = fetch_login(&account.token).map_err(|_| {
        AppError::new(
            "network_account_verify",
            "GitHub could not verify the transferred authorization.",
        )
    })?;
    if verified != account.login {
        return Err(AppError::new(
            "network_account_identity",
            "The transferred GitHub identity does not match.",
        ));
    }
    write_account(config_dir, &account)
}

pub fn disconnect(config_dir: &Path) -> Result<(), AppError> {
    let path = account_path(config_dir);
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

fn post_form(url: &str, fields: &[(&str, &str)]) -> Result<serde_json::Value, AppError> {
    let response = ureq::post(url)
        .set("Accept", "application/json")
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(20))
        .send_form(fields);
    let body = match response {
        Ok(response) => response.into_string()?,
        // A 4xx still carries a JSON error body that the caller must read.
        Err(ureq::Error::Status(_, response)) => response.into_string()?,
        Err(error) => {
            return Err(AppError::new(
                "github_unreachable",
                format!("Could not reach GitHub: {error}"),
            ))
        }
    };
    serde_json::from_str(&body).map_err(|error| {
        AppError::new(
            "github_bad_response",
            format!("GitHub returned an unreadable response: {error}"),
        )
    })
}

fn field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|found| found.as_str())
}

/// Ask GitHub for a code, which the user approves in their browser.
pub fn start(client_id: &str) -> Result<DeviceStart, AppError> {
    let id = crate::settings::validate_github_client_id(client_id)?;
    let body = post_form(DEVICE_CODE_URL, &[("client_id", &id), ("scope", SCOPE)])?;

    if let Some(error) = field(&body, "error") {
        let description = field(&body, "error_description").unwrap_or(error);
        // The most common setup mistake: the OAuth App exists but device flow
        // was never switched on, which is off by default.
        let code = if error == "device_flow_disabled" {
            "github_device_flow_disabled"
        } else {
            "github_device_start_failed"
        };
        return Err(AppError::new(code, description.to_string()));
    }

    let user_code = field(&body, "user_code")
        .ok_or_else(|| AppError::new("github_bad_response", "GitHub returned no user code."))?;
    if user_code.is_empty()
        || user_code.len() > 32
        || !user_code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(AppError::new(
            "github_bad_response",
            "GitHub returned an unusable device code.",
        ));
    }
    let verification_uri = field(&body, "verification_uri")
        .unwrap_or("https://github.com/login/device")
        .to_string();
    let device_code = field(&body, "device_code")
        .ok_or_else(|| AppError::new("github_bad_response", "GitHub returned no device code."))?;

    // RFC 8628 defines `verification_uri_complete` and GitHub does not send
    // it, but it does honour the `user_code` query parameter, which achieves
    // the same thing. Prefer the standard field if it ever appears.
    let verification_uri_complete = field(&body, "verification_uri_complete")
        .map(str::to_string)
        .unwrap_or_else(|| format!("{verification_uri}?user_code={user_code}"));

    Ok(DeviceStart {
        user_code: user_code.to_string(),
        verification_uri,
        verification_uri_complete,
        device_code: device_code.to_string(),
        interval_secs: body.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
        expires_in_secs: body
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(900),
    })
}

/// One poll. The caller drives the interval so the window stays responsive.
pub fn poll(
    config_dir: &Path,
    client_id: &str,
    device_code: &str,
) -> Result<PollOutcome, AppError> {
    let id = crate::settings::validate_github_client_id(client_id)?;
    let body = post_form(
        ACCESS_TOKEN_URL,
        &[
            ("client_id", &id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;

    if let Some(error) = field(&body, "error") {
        return Ok(match error {
            "authorization_pending" => PollOutcome::Pending,
            "slow_down" => PollOutcome::SlowDown {
                interval_secs: body.get("interval").and_then(|v| v.as_u64()).unwrap_or(10),
            },
            "access_denied" => PollOutcome::Denied,
            "expired_token" => PollOutcome::Expired,
            other => {
                let description = field(&body, "error_description").unwrap_or(other);
                return Err(AppError::new(
                    "github_device_poll_failed",
                    description.to_string(),
                ));
            }
        });
    }

    let token = field(&body, "access_token")
        .ok_or_else(|| AppError::new("github_bad_response", "GitHub returned no access token."))?;
    let scope = field(&body, "scope").unwrap_or(SCOPE).to_string();
    let login = fetch_login(token)?;

    write_account(
        config_dir,
        &StoredAccount {
            token: token.to_string(),
            login: login.clone(),
            scope,
        },
    )?;

    Ok(PollOutcome::Connected { login })
}

fn fetch_login(token: &str) -> Result<String, AppError> {
    let response = ureq::get(USER_URL)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|error| {
            AppError::new(
                "github_unreachable",
                format!("Connected, but could not read the account name: {error}"),
            )
        })?;
    let body: serde_json::Value = serde_json::from_str(&response.into_string()?)?;
    Ok(field(&body, "login").unwrap_or("github").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_consent_covers_the_feature_set_without_destructive_scopes() {
        // Repository contents, creation and Pages administration, plus the
        // workflow file the Pages setup writes. Nothing else.
        assert_eq!(SCOPE, "repo workflow");
        for forbidden in [
            "delete_repo",
            "admin:org",
            "admin:enterprise",
            "gist",
            "notifications",
            "user",
            "write:packages",
        ] {
            assert!(
                !SCOPE.split(' ').any(|granted| granted == forbidden),
                "{forbidden} must not be requested"
            );
        }
    }

    /// The constant is assembled with line continuations, which silently drop
    /// leading whitespace; a stray space would send the user to a broken page.
    #[test]
    fn the_registration_url_is_one_well_formed_prefilled_link() {
        assert!(REGISTRATION_URL.starts_with("https://github.com/settings/applications/new?"));
        assert!(!REGISTRATION_URL.contains(char::is_whitespace));
        assert!(REGISTRATION_URL.contains("oauth_application%5Bname%5D=Secret%20Tunnel%20v3"));
    }

    /// A downloaded copy must be able to connect with no setup at all.
    #[test]
    fn the_shipped_build_can_connect_without_registering_anything() {
        assert!(!CLIENT_ID.is_empty(), "the product ships its own OAuth App");
        assert_eq!(
            crate::settings::validate_github_client_id(CLIENT_ID).unwrap(),
            CLIENT_ID
        );
        assert_eq!(resolve_client_id().unwrap(), CLIENT_ID);
    }

    #[test]
    fn state_is_disconnected_without_a_stored_account() {
        let dir = std::env::temp_dir().join(format!("st-acct-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let observed = stored_state(&dir);
        assert!(!observed.connected);
        assert!(observed.login.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stored_account_reads_back_as_connected_and_clears_on_disconnect() {
        let dir = std::env::temp_dir().join(format!("st-acct-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        write_account(
            &dir,
            &StoredAccount {
                token: "fixture-token-not-real".to_string(),
                login: "fixture-user".to_string(),
                scope: "repo".to_string(),
            },
        )
        .unwrap();

        let observed = stored_state(&dir);
        assert!(observed.connected);
        assert_eq!(observed.login.as_deref(), Some("fixture-user"));

        disconnect(&dir).unwrap();
        assert!(!stored_state(&dir).connected);
        assert!(!account_path(&dir).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn repository_names_reject_paths_options_and_traversal() {
        for good in ["notes", "my-repo", "my_repo.v2", "a"] {
            assert!(
                validate_repository_name(good).is_ok(),
                "{good:?} should be accepted"
            );
        }
        for bad in [
            "",
            ".",
            "..",
            "-starts-with-dash",
            "owner/repo",
            "has space",
            "semi;colon",
            "uniécode",
        ] {
            assert!(
                validate_repository_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
        assert!(validate_repository_name(&"a".repeat(101)).is_err());
    }

    #[test]
    fn disconnect_is_safe_when_nothing_is_stored() {
        let dir = std::env::temp_dir().join(format!("st-acct-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert!(disconnect(&dir).is_ok());
        fs::remove_dir_all(&dir).ok();
    }
}

/* ------------------------------------------------------- GitHub API access */

const CREATE_REPO_URL: &str = "https://api.github.com/user/repos";

/// Where the token used for an API call came from, so the desktop can say so
/// rather than leaving the user to guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    /// Granted to this app through the device flow, with the scope above.
    ConnectedAccount,
    /// Borrowed from Git's own credential helper. The user granted this to
    /// their Git credential manager, not to this app, and its scope is
    /// whatever that grant carried.
    GitCredentialHelper,
}

/// The credential Secret Tunnel's own managed publication authenticates with.
///
/// Same resolution order as every API call: the token the user granted when
/// they connected GitHub, and only if there is none, the credential Git
/// already holds. Handing this to the push path is what makes one deliberate
/// connection sufficient, instead of the push depending on whatever happens to
/// be in the machine's credential manager.
pub fn publication_credential(config_dir: &Path) -> Result<(String, TokenSource), AppError> {
    api_token(config_dir)
}

/// A verified identity, not merely a cached login label. No credential is returned.
pub fn verified_identity(config_dir: &Path) -> Result<(String, TokenSource), AppError> {
    let (credential, source) = api_token(config_dir)?;
    Ok((fetch_login(&credential)?, source))
}

pub fn create_repository_for(
    config_dir: &Path,
    name: &str,
    expected_login: &str,
) -> Result<(CreatedRepository, TokenSource), AppError> {
    create_repository_inner(config_dir, name, true, Some(expected_login))
}

/// Prefer this app's own consented token. Fall back to the credential helper
/// that Git already uses for github.com, which is what makes repository
/// creation work before any OAuth app is registered.
fn api_token(config_dir: &Path) -> Result<(String, TokenSource), AppError> {
    if let Some(account) = read_account(config_dir) {
        return Ok((account.token, TokenSource::ConnectedAccount));
    }
    if account_path(config_dir).exists() {
        return Err(AppError::new("account_store_unreadable", "The saved account cannot be read. Repair it locally rather than silently switching identities."));
    }
    match git_credential_token() {
        Some(token) => Ok((token, TokenSource::GitCredentialHelper)),
        None => Err(AppError::new(
            "github_not_connected",
            "Connect a GitHub account first, or sign in to GitHub with Git so a credential is available.",
        )),
    }
}

/// Ask Git for the credential it already uses for github.com.
///
/// Fixed argv and bounded stdin use the same sanitized, noninteractive executor
/// as Git. Credential output is consumed privately and never logged.
fn git_credential_token() -> Option<String> {
    use super::exec::{self, resolve_tool, CancelToken, CommandSpec, Tool};
    let tool = resolve_tool(Tool::Git).ok()?;
    let output = exec::run(
        CommandSpec::new(tool, std::env::temp_dir())
            .arg("credential")
            .arg("fill")
            .input(b"protocol=https\nhost=github.com\n\n".to_vec())
            .deadline(Duration::from_secs(15)),
        &CancelToken::new(),
    )
    .ok()?;
    // This result is private and is never sent to audit output or to MCP.
    if !output.success() || output.stdout_truncated {
        return None;
    }
    for line in output.stdout.lines() {
        if let Some(value) = line.strip_prefix("password=") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// A repository that now exists on GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepository {
    /// GitHub's immutable numeric id, used as the identity anchor.
    pub id: u64,
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
    pub private: bool,
    pub default_branch: String,
}

/// GitHub's own record of the Pages site. `GET /repos/{owner}/{repo}/pages`
/// requires authentication even for a public repository, so this is the only
/// way the Pages verifier can see the site's build type, URL and domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesSite {
    pub build_type: Option<String>,
    pub html_url: Option<String>,
    pub cname: Option<String>,
    pub https_enforced: bool,
    pub source_branch: Option<String>,
    pub source_path: Option<String>,
}

/// Read the bound repository's Pages site. `None` means GitHub has no Pages
/// site for it, which is a fact about the repository, not a failure.
pub fn read_pages_site(
    config_dir: &Path,
    owner: &str,
    repo: &str,
) -> Result<Option<PagesSite>, AppError> {
    validate_repository_name(owner)?;
    validate_repository_name(repo)?;
    let (token, _source) = api_token(config_dir)?;
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pages");
    match ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(20))
        .call()
    {
        Ok(response) => {
            let value: serde_json::Value = serde_json::from_str(&response.into_string()?)?;
            Ok(Some(PagesSite {
                build_type: field(&value, "build_type").map(str::to_string),
                html_url: field(&value, "html_url").map(str::to_string),
                cname: field(&value, "cname").map(str::to_string),
                https_enforced: value
                    .get("https_enforced")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                source_branch: value
                    .get("source")
                    .and_then(|s| field(s, "branch"))
                    .map(str::to_string),
                source_path: value
                    .get("source")
                    .and_then(|s| field(s, "path"))
                    .map(str::to_string),
            }))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(ureq::Error::Status(status, reply)) => Err(AppError::new(
            "github_pages_unreadable",
            pages_failure(status, reply, "read the Pages site"),
        )),
        Err(error) => Err(AppError::new(
            "github_unreachable",
            format!("Could not reach GitHub: {error}"),
        )),
    }
}

/// What GitHub reports about the Pages site after `enable_pages` ran.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesConfiguration {
    /// "enabled" or "already_enabled".
    pub pages: String,
    /// The custom domain GitHub itself reports, read back rather than echoed.
    pub domain: Option<String>,
    /// GitHub's own https_enforced flag, read back rather than assumed.
    pub https_enforced: bool,
    /// Why HTTPS is not enforced yet, when it was asked for and refused.
    pub note: Option<String>,
}

/// A custom Pages domain goes into a GitHub request body and then becomes the
/// only non-default origin the Pages verifier will fetch, so accept a plain
/// hostname and nothing that could change either meaning.
pub fn validate_pages_domain(domain: &str) -> Result<(), AppError> {
    let invalid = || {
        AppError::new(
            "invalid_domain",
            "A custom domain must be a plain lowercase hostname such as example.com.",
        )
    };
    if domain.len() < 4 || domain.len() > 253 || !domain.contains('.') {
        return Err(invalid());
    }
    if domain.starts_with('.')
        || domain.starts_with('-')
        || domain.ends_with('.')
        || domain.ends_with('-')
        || domain.contains("..")
    {
        return Err(invalid());
    }
    if !domain
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
    {
        return Err(invalid());
    }
    Ok(())
}

/// Turn on GitHub Pages with GitHub Actions as the build source, and bind a
/// custom domain to it when one is given.
///
/// Idempotent: GitHub answers 409 when Pages already exists, which is success
/// for our purposes. Without a domain only the build type is set, so an
/// existing configuration is left alone. With one, the site is updated through
/// `PUT /repos/{owner}/{repo}/pages`, which is the configuration mechanism for
/// workflow-built Pages; a repository `CNAME` file is not.
pub fn enable_pages(
    config_dir: &Path,
    owner: &str,
    repo: &str,
    domain: Option<&str>,
    https_enforced: bool,
) -> Result<PagesConfiguration, AppError> {
    validate_repository_name(owner)?;
    validate_repository_name(repo)?;
    if let Some(domain) = domain {
        validate_pages_domain(domain)?;
    }
    let (token, _source) = api_token(config_dir)?;
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pages");
    let response = ureq::post(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&serde_json::json!({ "build_type": "workflow" }).to_string());

    let pages = match response {
        Ok(_) => "enabled".to_string(),
        // Already configured. Leave whatever is there untouched.
        Err(ureq::Error::Status(409, _)) => "already_enabled".to_string(),
        Err(ureq::Error::Status(status, reply)) => {
            return Err(AppError::new(
                "github_pages_refused",
                pages_failure(status, reply, "enable Pages"),
            ))
        }
        Err(error) => {
            return Err(AppError::new(
                "github_unreachable",
                format!("Could not reach GitHub: {error}"),
            ))
        }
    };

    let Some(domain) = domain else {
        return Ok(PagesConfiguration {
            pages,
            domain: None,
            https_enforced: false,
            note: None,
        });
    };

    update_pages(
        &url,
        &token,
        &serde_json::json!({ "cname": domain, "build_type": "workflow" }),
    )
    .map_err(|(status, reply)| {
        AppError::new(
            "github_pages_domain_refused",
            pages_failure(status, reply, "set the custom domain"),
        )
    })?;

    // HTTPS can only be enforced once GitHub has issued the certificate for the
    // domain, which needs correct DNS and takes minutes. Asking early is normal,
    // so it is reported rather than failing the whole call.
    let mut note = None;
    if https_enforced {
        if let Err((status, reply)) =
            update_pages(&url, &token, &serde_json::json!({ "https_enforced": true }))
        {
            note = Some(pages_failure(status, reply, "enforce HTTPS"));
        }
    }

    // Report what GitHub says, not what was asked for.
    let site = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|error| {
            AppError::new(
                "github_unreachable",
                format!("Could not read the Pages site back: {error}"),
            )
        })?;
    let value: serde_json::Value = serde_json::from_str(&site.into_string()?)?;
    Ok(PagesConfiguration {
        pages,
        domain: field(&value, "cname").map(str::to_string),
        https_enforced: value
            .get("https_enforced")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        note,
    })
}

/// One authenticated `PUT` against the bound repository's Pages site. The
/// refusal is handed back whole so the caller decides whether it is fatal.
fn update_pages(
    url: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<(), (u16, Option<ureq::Response>)> {
    match ureq::put(url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body.to_string())
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(status, reply)) => Err((status, Some(reply))),
        Err(_) => Err((0, None)),
    }
}

fn pages_failure(status: u16, reply: impl Into<Option<ureq::Response>>, what: &str) -> String {
    let detail = reply
        .into()
        .and_then(|reply| reply.into_string().ok())
        .unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&detail)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            if status == 0 {
                format!("Could not reach GitHub to {what}.")
            } else {
                format!("GitHub refused to {what} with status {status}.")
            }
        })
}

/// Look up the immutable numeric id of an existing repository.
///
/// Used to fill a binding made before the id was recorded. Read-only: it
/// creates nothing and changes nothing on GitHub.
pub fn resolve_repository_id(config_dir: &Path, owner: &str, repo: &str) -> Result<u64, AppError> {
    validate_repository_name(repo)?;
    validate_repository_name(owner)?;
    let (token, _source) = api_token(config_dir)?;
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let response = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|error| {
            AppError::new(
                "github_unreachable",
                format!("Could not read the repository: {error}"),
            )
        })?;
    let value: serde_json::Value = serde_json::from_str(&response.into_string()?)?;
    value
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| AppError::new("github_bad_response", "GitHub returned no repository id."))
}

/// Repository names go into a URL and into Git remotes, so accept only what
/// GitHub itself accepts and nothing that could change the request's meaning.
pub fn validate_repository_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::new(
            "invalid_repository_name",
            "A repository name must be between 1 and 100 characters.",
        ));
    }
    if name == "." || name == ".." || name.starts_with('-') {
        return Err(AppError::new(
            "invalid_repository_name",
            "That repository name is not allowed.",
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::new(
            "invalid_repository_name",
            "A repository name may use letters, digits, dot, dash and underscore only.",
        ));
    }
    Ok(())
}

/// Create a repository under the authenticated account.
///
/// Deliberately creates it private by default: a repository that should be
/// public can be opened later, but content published by mistake cannot be
/// un-published.
pub fn create_repository(
    config_dir: &Path,
    name: &str,
    private: bool,
) -> Result<(CreatedRepository, TokenSource), AppError> {
    create_repository_inner(config_dir, name, private, None)
}

fn create_repository_inner(
    config_dir: &Path,
    name: &str,
    private: bool,
    expected_login: Option<&str>,
) -> Result<(CreatedRepository, TokenSource), AppError> {
    validate_repository_name(name)?;
    let (token, source) = api_token(config_dir)?;
    if let Some(expected) = expected_login {
        if fetch_login(&token)? != expected {
            return Err(AppError::new(
                "account_changed",
                "The verified account differs from the approved account.",
            ));
        }
    }

    let body = serde_json::json!({
        "name": name,
        "private": private,
        "auto_init": false,
    });

    let response = ureq::post(CREATE_REPO_URL)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body.to_string());

    let text = match response {
        Ok(response) => response.into_string()?,
        Err(ureq::Error::Status(status, response)) => {
            let detail = response.into_string().unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&detail)
                .ok()
                .and_then(|value| {
                    value
                        .get("message")
                        .and_then(|found| found.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("GitHub refused the request with status {status}."));
            let code = match status {
                401 | 403 => "github_forbidden",
                422 => "github_name_unavailable",
                _ => "github_create_failed",
            };
            return Err(AppError::new(code, message));
        }
        Err(error) => {
            return Err(AppError::new(
                "github_unreachable",
                format!("Could not reach GitHub: {error}"),
            ))
        }
    };

    let value: serde_json::Value = serde_json::from_str(&text)?;
    Ok((
        CreatedRepository {
            id: value.get("id").and_then(|v| v.as_u64()).ok_or_else(|| {
                AppError::new("github_bad_response", "GitHub returned no repository id.")
            })?,
            full_name: field(&value, "full_name")
                .ok_or_else(|| {
                    AppError::new("github_bad_response", "GitHub returned no repository name.")
                })?
                .to_string(),
            html_url: field(&value, "html_url").unwrap_or_default().to_string(),
            clone_url: field(&value, "clone_url").unwrap_or_default().to_string(),
            private: value
                .get("private")
                .and_then(|found| found.as_bool())
                .unwrap_or(private),
            default_branch: field(&value, "default_branch")
                .unwrap_or("main")
                .to_string(),
        },
        source,
    ))
}
