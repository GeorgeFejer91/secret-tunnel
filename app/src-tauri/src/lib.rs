mod actions;
mod commands;
mod diag;
// UNFINISHED: the online-installer download helper references symbols that do
// not exist and does not compile. It is kept behind an off-by-default feature
// so it cannot break the application build, and it is not a shipped feature
// until it is reworked into its own binary target.
#[cfg(feature = "online-installer")]
mod download_helper;
mod error;
mod github;
mod lifecycle;
mod ownership;
mod process;
mod readiness;
mod settings;

use process::AppState;
use tauri::Manager;

use crate::ownership::{acquire_profile_lock, request_activation, ActivationOutcome, LockState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = settings::app_paths().expect("failed to resolve app data paths");

    // Non-mutating preflight / profile-report mode: when
    // SECRET_TUNNEL_PROFILE_REPORT is set, write a JSON report describing the
    // resolved profile (proving SECRET_TUNNEL_CONFIG_DIR isolation works), then
    // exit before touching settings, services, or the UI. The smoke harness uses
    // this to verify it is about to run against an isolated, honoring binary.
    if let Some(report_path) = std::env::var_os("SECRET_TUNNEL_PROFILE_REPORT") {
        write_profile_report(&paths, &report_path);
        return;
    }

    // Acquire the OS-backed exclusive profile lock BEFORE applying launch
    // overrides, loading settings through any write-capable function, starting
    // services, or performing cleanup. The canonical config directory scopes
    // the lock so production and isolated smoke-test profiles never contend.
    let profile_lock = match acquire_profile_lock(&paths.config_dir) {
        Ok(LockState::Acquired(lock)) => Some(lock),
        Ok(LockState::HeldElsewhere(_)) => {
            let outcome = request_activation(&paths.config_dir, None)
                .unwrap_or(ActivationOutcome::WriteFailed);
            match outcome {
                ActivationOutcome::Activated => {
                    eprintln!("Opened the existing Secret Tunnel window.");
                    std::process::exit(0);
                }
                ActivationOutcome::WriteFailed => {
                    eprintln!("Secret Tunnel is already running for this profile.");
                    std::process::exit(2);
                }
                ActivationOutcome::AlreadyRunning => {
                    eprintln!("Secret Tunnel is already running for this profile.");
                    std::process::exit(1);
                }
            }
        }
        Err(error) => {
            eprintln!(
                "Could not acquire the profile lock ({}): {}",
                error.code, error.message
            );
            std::process::exit(3);
        }
    };

    if github::account::upgrade_local_storage(&paths.config_dir).is_err() {
        eprintln!("GitHub account storage upgrade failed. Inspect local account settings before connecting.");
    }

    let github_paths = paths.clone();
    let launch_environment = settings::apply_launch_environment_overrides(&paths)
        .ok()
        .flatten();
    let coordinator =
        std::sync::Arc::new(github::coordinator::GitHubCoordinator::new(github_paths));
    let runtime_identity = coordinator.runtime_identity();
    std::env::set_var("SECRET_TUNNEL_INSTANCE_ID", &runtime_identity.instance_id);
    std::env::set_var("SECRET_TUNNEL_BUILD_ID", &runtime_identity.build_id);
    std::env::set_var(
        "SECRET_TUNNEL_APP_VERSION",
        &runtime_identity.application_version,
    );
    // A failed broker startup must not inherit another process's configuration.
    std::env::remove_var("SECRET_TUNNEL_BROKER_URL");
    std::env::remove_var("SECRET_TUNNEL_BROKER_TOKEN");

    // How the bundled MCP server reaches the coordinator. Loopback only, with
    // an ephemeral token handed to the child through its environment. A broker
    // that fails to start is not fatal: the app runs without GitHub actions
    // rather than refusing to open.
    let broker = match github::broker::Broker::start(coordinator.clone()) {
        Ok(broker) => Some(std::sync::Arc::new(broker)),
        Err(error) => {
            eprintln!("GitHub broker unavailable: {}", error.message);
            None
        }
    };
    if let Some(broker) = &broker {
        std::env::set_var("SECRET_TUNNEL_BROKER_URL", broker.base_url());
        std::env::set_var("SECRET_TUNNEL_BROKER_TOKEN", &broker.token);
    }

    let app_state = AppState::with_profile_lock(paths, launch_environment, profile_lock);
    let startup_state = app_state.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        .manage(actions::ActionsState::default())
        .manage(coordinator.clone())
        .setup(move |app| {
            app.state::<std::sync::Arc<github::coordinator::GitHubCoordinator>>()
                .attach_actions(app.state::<actions::ActionsState>().inner().clone())
                .map_err(|_| {
                    std::io::Error::other("Could not connect the shared operation guard.")
                })?;
            if let Ok(resource_dir) = app.path().resource_dir() {
                std::env::set_var("SECRET_TUNNEL_RESOURCE_DIR", resource_dir);
            }
            // Owner-side activation watcher: a second launch of the same
            // profile requests its window be shown/unminimized/focused.
            let activation_config_dir = startup_state.paths.config_dir.clone();
            if let Ok(watcher) = ownership::ActivationWatcher::spawn(&activation_config_dir, {
                let app_handle = app.handle().clone();
                move || {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }) {
                startup_state.set_activation_watcher(watcher);
            }
            if launched_in_background() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            std::thread::spawn({
                let state = startup_state.clone();
                move || {
                    if std::env::var("SECRET_TUNNEL_ACTIONS_ONLY").as_deref() == Ok("1") {
                        state.push_app_log("Actions-only mode: tunnel startup is disabled.");
                        return;
                    }
                    if let Err(error) = state.enable_zrok_from_environment_if_present() {
                        state.push_app_log(format!("zrok auto-enable failed: {}", error.message));
                    }
                    // Backend supervisor schedules retries while desired_running
                    // is true; it is NOT driven by webview status polling.
                    state.start_supervisor();
                    // Surface a failed launch start instead of discarding it:
                    // an unreadable settings file or an invalid workspace used
                    // to leave the window open with no services and no reason
                    // shown anywhere.
                    if let Err(error) = state.start_if_configured() {
                        state.push_app_log(format!(
                            "Auto-start failed: {}: {}",
                            error.code, error.message
                        ));
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            actions::open_actions,
            actions::actions_request,
            commands::get_status,
            commands::choose_workspace_folder,
            commands::set_workspace_path,
            commands::set_access_mode,
            commands::set_autostart,
            commands::enable_zrok,
            commands::open_url,
            commands::regenerate_mcp_url,
            commands::start_services,
            commands::stop_services,
            commands::github_status,
            commands::github_set_enabled,
            commands::github_bind,
            commands::github_unbind,
            commands::github_init_repository,
            commands::github_plan,
            commands::github_approve,
            commands::github_cancel,
            commands::github_apply,
            commands::github_operation_status,
            commands::github_account_status,
            commands::github_account_connect,
            commands::github_account_poll,
            commands::github_account_disconnect
        ])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.state::<actions::ActionsState>().stop_all();
                let state = window.state::<AppState>();
                state.stop_all();
            }
        });

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--background"]),
    ));

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn write_profile_report(paths: &settings::AppPaths, report_path: &std::ffi::OsStr) {
    use serde_json::json;

    let lock_status = match acquire_profile_lock(&paths.config_dir) {
        Ok(LockState::Acquired(_)) => "acquired".to_string(),
        Ok(LockState::HeldElsewhere(_)) => "held-elsewhere".to_string(),
        Err(error) => format!("error:{}", error.code),
    };
    let report = json!({
        "binary": "secret-tunnel-v2",
        "githubContractVersion": github::operations::CONTRACT_VERSION,
        "identity": diag::build_identity(),
        "fingerprint": diag::executable_fingerprint(),
        "pid": std::process::id(),
        "profileDir": paths.config_dir,
        "settingsPath": paths.settings_path,
        "managedConfigPath": paths.managed_config_path,
        "diagnosticsPath": paths.diagnostics_path,
        "isolatedProfile": std::env::var_os("SECRET_TUNNEL_CONFIG_DIR").is_some(),
        "actionsFramework": 1,
        "actionsOnly": std::env::var("SECRET_TUNNEL_ACTIONS_ONLY").as_deref() == Ok("1"),
        "profileLock": lock_status,
    });

    if let Some(parent) = std::path::Path::new(report_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        report_path,
        serde_json::to_vec_pretty(&report).unwrap_or_default(),
    );
}

fn launched_in_background() -> bool {
    std::env::args().any(|arg| arg == "--background")
}
