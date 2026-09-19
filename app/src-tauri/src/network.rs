//! Native owner of the private device companion. No network administration is an MCP tool.
use crate::error::AppError;
use crate::github::{account, coordinator::GitHubCoordinator, credential_store};
use crate::process::{
    bundled_executable, bundled_mcp_runtime_dir, suppress_console_window, AppState,
};
use crate::settings::{
    load_or_create_settings, save_settings, write_managed_mcp_config, AppPaths, Settings,
};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

pub struct NetworkState {
    paths: AppPaths,
    child: Mutex<Option<Child>>,
    admin: String,
    mcp: String,
    instance: String,
    closing: AtomicBool,
}
fn fresh() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn failure() -> AppError {
    AppError::new(
        "network_unavailable",
        "Network service unavailable. Rebuild and prepare the bundled network-service.js runtime.",
    )
}
/// An invitation is a short string and the sealed envelope around it is a few
/// hundred bytes. Kept under the 12 kB request ceiling below so the same bound
/// is the effective one on the way out and on the way in.
const MAX_INVITATION_FILE: usize = 8 * 1024;
impl NetworkState {
    pub fn new(paths: AppPaths) -> Self {
        let state = Self {
            paths,
            child: Mutex::new(None),
            admin: fresh(),
            mcp: fresh(),
            instance: fresh(),
            closing: AtomicBool::new(false),
        };
        // Only the restricted file-routing credential reaches the ordinary MCP child.
        std::env::set_var(
            "SECRET_TUNNEL_NETWORK_DESCRIPTOR",
            state.paths.config_dir.join("network-runtime.json"),
        );
        std::env::set_var("SECRET_TUNNEL_NETWORK_INSTANCE", &state.instance);
        std::env::set_var("SECRET_TUNNEL_NETWORK_MCP_KEY", &state.mcp);
        state
    }
    pub fn start_supervisor(self: &Arc<Self>) {
        let state = self.clone();
        std::thread::spawn(move || {
            while !state.closing.load(Ordering::SeqCst) {
                let _ = state.ensure_running();
                std::thread::sleep(Duration::from_secs(10));
            }
        });
    }
    fn ensure_running(&self) -> Result<u16, AppError> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(failure());
        }
        let mut slot = self.child.lock().map_err(|_| failure())?;
        if let Some(child) = slot.as_mut() {
            if child.try_wait()?.is_none() {
                return self.port(child.id());
            }
        }
        *slot = None;
        let runtime = bundled_mcp_runtime_dir().ok_or_else(failure)?;
        let script = runtime.join("dist").join("network-service.js");
        if !script.is_file() {
            return Err(failure());
        }
        let node = bundled_executable("node").ok_or_else(failure)?;
        let settings = load_or_create_settings(&self.paths)?;
        if settings.workspace_path.is_some() {
            write_managed_mcp_config(&self.paths, &settings)?;
        }
        fs::create_dir_all(&self.paths.config_dir)?;
        let mut command = Command::new(node);
        suppress_console_window(&mut command);
        command
            .arg(script)
            .current_dir(runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("SECRET_TUNNEL_NETWORK_ADMIN_KEY", &self.admin)
            .env("SECRET_TUNNEL_NETWORK_MCP_KEY", &self.mcp)
            .env("SECRET_TUNNEL_NETWORK_INSTANCE", &self.instance)
            .env(
                "SECRET_TUNNEL_NETWORK_DESCRIPTOR",
                self.paths.config_dir.join("network-runtime.json"),
            )
            .env(
                "SECRET_TUNNEL_NETWORK_CONFIG",
                &self.paths.managed_config_path,
            )
            .env("SECRET_TUNNEL_NETWORK_SETTINGS", &self.paths.settings_path);
        let mut child = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && !self.closing.load(Ordering::SeqCst) {
            if child.try_wait()?.is_some() {
                return Err(failure());
            }
            if let Ok(port) = self.port(child.id()) {
                *slot = Some(child);
                return Ok(port);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        Err(failure())
    }
    fn port(&self, pid: u32) -> Result<u16, AppError> {
        let path = self.paths.config_dir.join("network-runtime.json");
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 2048 {
            return Err(failure());
        }
        let value: Value = serde_json::from_slice(&fs::read(path)?)?;
        if value["pid"].as_u64() != Some(pid as u64)
            || value["instance"].as_str() != Some(self.instance.as_str())
            || value["version"] != 1
        {
            return Err(failure());
        }
        let port = value["port"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= 65535)
            .ok_or_else(failure)?;
        Ok(port as u16)
    }
    fn control(&self, input: Value) -> Result<Value, AppError> {
        let port = self.ensure_running()?;
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_secs(35))
            .build();
        let response = agent
            .post(&format!("http://127.0.0.1:{port}/control"))
            .set("Authorization", &format!("Bearer {}", self.admin))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::to_string(&input)?);
        let (ok, response) = match response {
            Ok(value) => (true, value),
            Err(ureq::Error::Status(_, value)) => (false, value),
            Err(_) => return Err(failure()),
        };
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(1_048_577)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1_048_576 {
            return Err(failure());
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if !ok {
            let code = value["error"]
                .as_str()
                .unwrap_or("network_operation_failed");
            let safe =
                code.len() <= 80 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
            return Err(AppError::new(
                "network_request",
                if safe {
                    code
                } else {
                    "network_operation_failed"
                },
            ));
        }
        Ok(value)
    }
    pub fn stop(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                drop(child.stdin.take()); // EOF asks the companion to cancel polls and close.
                let until = Instant::now() + Duration::from_secs(2);
                while Instant::now() < until {
                    if child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Fixed private-file persistence, called only by the authenticated native broker.
/// The file is DPAPI-protected on Windows; Unix protection is mode 0600, not encryption.
pub(crate) fn storage(input: &Value) -> Result<Value, AppError> {
    let paths = crate::settings::app_paths()?;
    let path = paths.config_dir.join("network-credentials.json");
    match input["action"].as_str() {
        Some("load") => {
            if !path.exists() {
                return Ok(json!({"state": null}));
            }
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 128 * 1024 {
                return Err(failure());
            }
            let plain = credential_store::decode(&fs::read(path)?).map_err(|_| failure())?;
            Ok(json!({"state": serde_json::from_slice::<Value>(&plain).map_err(|_| failure())?}))
        }
        Some("save") => {
            let value = &input["state"];
            let mut plain = serde_json::to_vec(value)?;
            if !value.is_object() || value["version"] != 1 || plain.len() > 30_000 {
                return Err(failure());
            }
            let protected = credential_store::encode(&plain);
            plain.fill(0);
            let protected = protected.map_err(|_| failure())?;
            fs::create_dir_all(&paths.config_dir)?;
            let temporary = paths.config_dir.join(format!(
                "network-write-{}.tmp",
                uuid::Uuid::new_v4().simple()
            ));
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
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
            result?;
            Ok(json!({"saved": true}))
        }
        _ => Err(AppError::new(
            "network_action",
            "Unknown private storage operation.",
        )),
    }
}

#[tauri::command]
pub async fn network_request(
    window: tauri::WebviewWindow,
    app: AppHandle,
    network: State<'_, Arc<NetworkState>>,
    state: State<'_, AppState>,
    coordinator: State<'_, Arc<GitHubCoordinator>>,
    action: String,
    input: Value,
) -> Result<Value, AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            "network_origin",
            "Network administration requires the main desktop window.",
        ));
    }
    let network = network.inner().clone();
    let state = state.inner().clone();
    let coordinator = coordinator.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        request(&app, &network, &state, &coordinator, &action, input)
    })
    .await
    .map_err(|_| failure())?
}
fn request(
    app: &AppHandle,
    network: &NetworkState,
    state: &AppState,
    coordinator: &GitHubCoordinator,
    action: &str,
    input: Value,
) -> Result<Value, AppError> {
    if serde_json::to_vec(&input)?.len() > 12_000 {
        return Err(failure());
    }
    match action {
        "status" => network.control(json!({"action": "status"})),
        "create" => {
            if !state.is_running()? {
                return Err(AppError::new(
                    "gateway_offline",
                    "Start the existing tunnel before creating an invitation.",
                ));
            }
            let settings = load_or_create_settings(&state.paths)?;
            let mode = input["mode"].as_str().unwrap_or("");
            let profile = if mode == "profile" {
                let include = input["includeGitHub"].as_bool().unwrap_or(false);
                json!({"version": 1, "settings": settings, "account": if include { account::network_export_account(&state.paths.config_dir)? } else { None }})
            } else {
                Value::Null
            };
            // A short code carries only eighty bits of seed, so it is allowed
            // exactly one expiry. The core refuses the pair otherwise; this
            // picks it rather than letting the two drift apart here.
            let short = input["short"].as_bool().unwrap_or(false);
            network.control(json!({"action": "create", "options": {"origin": format!("https://{}.shares.zrok.io", settings.zrok_name), "mode": mode, "label": "Device", "profile": profile, "short": short, "invitationMs": if short { 300_000 } else { 900_000 }}}))
        }
        "join" => {
            if !input["grant"].is_object() {
                return Err(AppError::new(
                    "invalid_grant",
                    "Choose local folders to share.",
                ));
            }
            // No zrok enable, no external listener, and no changes to the main endpoint.
            let settings = load_or_create_settings(&state.paths)?;
            if settings.workspace_path.is_some() {
                write_managed_mcp_config(&state.paths, &settings)?;
            }
            network.control(json!({"action": "redeem", "invitation": input["invitation"], "grant": input["grant"], "label": input["label"]}))
        }
        "receive_profile" => {
            if state.is_running()? {
                return Err(AppError::new(
                    "stop_before_import",
                    "Stop this PC's main tunnel before importing portable settings.",
                ));
            }
            if input["confirm"].as_bool() != Some(true) {
                return Err(AppError::new(
                    "confirm_import",
                    "Confirm the settings and authorization import locally.",
                ));
            }
            let received = network.control(json!({"action": "redeem", "invitation": input["invitation"], "grant": null, "label": "Settings recipient"}))?;
            let profile = &received["profile"];
            if received["kind"] != "profile" || profile["version"] != 1 {
                return Err(failure());
            }
            let source: Settings =
                serde_json::from_value(profile["settings"].clone()).map_err(|_| failure())?;
            let incoming_account = profile.get("account").filter(|v| !v.is_null()).cloned();
            let imported = incoming_account.is_some();
            // Keep local paths, executable paths, endpoint credentials and device identity.
            // Copying those would mislabel local folders or race an existing live share.
            coordinator.change_settings(|| crate::actions::change_settings(app, || {
                if state.is_running()? { return Err(AppError::new("stop_before_import", "This PC's main tunnel started during transfer. Stop it before retrying the import.")); }
                let mut target = load_or_create_settings(&state.paths)?;
                target.access_mode = source.access_mode;
                if let Some(account_value) = incoming_account {
                    account::network_import_account(&state.paths.config_dir, account_value)?;
                    target.github = source.github; target.github.binding = None;
                }
                if let Err(error) = save_settings(&state.paths, &target) {
                    if imported { let _ = account::disconnect(&state.paths.config_dir); }
                    return Err(error);
                }
                Ok(())
            }))?;
            Ok(
                json!({"kind": "profile", "importedGitHub": imported, "sameEndpoint": false, "message": "Portable settings imported. Local folders and this PC's endpoint were preserved. Set up this PC's own tunnel; shared-URL failover is not implemented."}),
            )
        }
        // The invitation file is sealed and opened in the webview with WebCrypto;
        // this end only puts the bytes where the person pointed. No network
        // service, no credential handling, and nothing written or read without
        // a native dialog the person drove themselves.
        "save_file" => {
            let contents = input["contents"]
                .as_str()
                .ok_or_else(|| AppError::new("invalid_file", "Nothing to save."))?;
            if contents.len() > MAX_INVITATION_FILE {
                return Err(AppError::new(
                    "invalid_file",
                    "That invitation file is too large.",
                ));
            }
            let Some(path) = rfd::FileDialog::new()
                .set_file_name("secret-tunnel-invitation.stn")
                .add_filter("Secret Tunnel invitation", &["stn"])
                .save_file()
            else {
                return Ok(json!({"saved": false}));
            };
            fs::write(&path, contents).map_err(|_| {
                AppError::new("save_failed", "Could not write the invitation file there.")
            })?;
            Ok(json!({"saved": true}))
        }
        "open_file" => {
            let Some(path) = rfd::FileDialog::new()
                .add_filter("Secret Tunnel invitation", &["stn"])
                .pick_file()
            else {
                return Ok(json!({"contents": null}));
            };
            let meta = fs::symlink_metadata(&path).map_err(|_| {
                AppError::new("open_failed", "Could not read that invitation file.")
            })?;
            if !meta.is_file() || meta.len() as usize > MAX_INVITATION_FILE {
                return Err(AppError::new(
                    "invalid_file",
                    "That is not a Secret Tunnel invitation file.",
                ));
            }
            let contents = fs::read_to_string(&path).map_err(|_| {
                AppError::new(
                    "invalid_file",
                    "That is not a Secret Tunnel invitation file.",
                )
            })?;
            Ok(json!({"contents": contents}))
        }
        "revoke" => network.control(json!({"action": "revoke", "id": input["id"]})),
        "leave" => network.control(json!({"action": "leave"})),
        _ => Err(AppError::new("network_action", "Unknown Network command.")),
    }
}
