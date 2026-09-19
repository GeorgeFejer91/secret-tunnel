use crate::error::AppError;
use crate::github::coordinator::{GitHubCoordinator, GitHubStatus};
use crate::github::plan::{Plan, PlanAction};
use crate::process::{AppState, StatusDto};
use crate::settings::{
    load_or_create_settings, save_settings, validate_workspace_path, AccessMode,
};
use crate::smart_folders::{self, SmartScanDto};
use crate::system_prompt::{SystemPromptDto, SystemPromptSettings};
use tauri::{AppHandle, Manager, State};

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn get_status(app: AppHandle, state: State<'_, AppState>) -> Result<StatusDto, AppError> {
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn choose_workspace_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StatusDto>, AppError> {
    let Some(path) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    let canonical = validate_workspace_path(&path.to_string_lossy())?;
    change_workspace_settings(&app, &state, |settings| {
        settings.workspace_path = Some(canonical)
    })?;
    sync_services_after_settings_change(&state)?;
    Ok(Some(state.snapshot(autostart_enabled(&app))?))
}

/// Add another folder to the set the MCP server exposes.
///
/// The same native picker and the same path validation as the primary folder:
/// an extra folder is not a lesser one, it just is not the folder the GitHub
/// binding is anchored to.
#[tauri::command]
pub fn add_extra_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StatusDto>, AppError> {
    let Some(path) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    let canonical = validate_workspace_path(&path.to_string_lossy())?;
    change_workspace_settings(&app, &state, |settings| {
        let already_primary = settings.workspace_path.as_deref() == Some(canonical.as_str());
        if !already_primary && !settings.extra_folders.contains(&canonical) {
            settings.extra_folders.push(canonical.clone());
        }
    })?;
    sync_services_after_settings_change(&state)?;
    Ok(Some(state.snapshot(autostart_enabled(&app))?))
}

#[tauri::command]
pub fn remove_extra_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<StatusDto, AppError> {
    change_workspace_settings(&app, &state, |settings| {
        settings.extra_folders.retain(|folder| folder != &path)
    })?;
    sync_services_after_settings_change(&state)?;
    state.snapshot(autostart_enabled(&app))
}

/// Read the immediate child directories of the chosen projects and group their
/// names. Read-only, and off the UI thread: a project with a thousand entries
/// must not stall the window.
///
/// Refreshing changes nothing about what is currently exposed. Only
/// `smart_folders_apply` does that.
#[tauri::command]
pub async fn smart_folders_scan(
    state: State<'_, AppState>,
    projects: Vec<String>,
) -> Result<SmartScanDto, AppError> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_or_create_settings(&paths)?;
        Ok(smart_folders::scan(&settings, &projects))
    })
    .await
    .map_err(|error| AppError::new("smart_folders_scan", error.to_string()))?
}

/// Restrict this endpoint to exactly the previewed folders.
///
/// The paths are re-proved against the registered projects here, so the window
/// chooses among what the backend offered and never supplies authority of its
/// own. The scope is saved before the services are reconfigured, and the
/// existing restart is what withdraws the broader sessions: a failure part way
/// through leaves the restriction stored and the services stopped, never the
/// old broad roots serving.
#[tauri::command]
pub fn smart_folders_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    folders: Vec<String>,
) -> Result<StatusDto, AppError> {
    let settings = load_or_create_settings(&state.paths)?;
    let scope = smart_folders::resolve(&settings, &name, &folders)?;
    change_workspace_settings(&app, &state, |settings| settings.smart_scope = Some(scope))?;
    sync_services_after_settings_change(&state)?;
    state.snapshot(autostart_enabled(&app))
}

/// Give the projects back in full. The one deliberate desktop action that
/// widens this endpoint again; nothing reachable over the tunnel can call it.
#[tauri::command]
pub fn smart_folders_clear(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StatusDto, AppError> {
    change_workspace_settings(&app, &state, |settings| settings.smart_scope = None)?;
    sync_services_after_settings_change(&state)?;
    state.snapshot(autostart_enabled(&app))
}

/// The System Prompt tab, read once when the window opens rather than on the
/// status poll: the panel holds two textareas the user is typing into, and a
/// four-second refresh would overwrite them mid-sentence.
#[tauri::command]
pub fn system_prompt_get(state: State<'_, AppState>) -> Result<SystemPromptDto, AppError> {
    let settings = load_or_create_settings(&state.paths)?;
    Ok(SystemPromptDto::from(&settings.system_prompt))
}

/// Save what the user typed, then restart the services so the MCP child is
/// spawned with the new instructions.
///
/// The restart is not incidental. A server's `instructions` are fixed at
/// `initialize`, so an edit that does not restart the child cannot reach
/// ChatGPT at all - and the same restart is what a folder change already does
/// for the same reason.
#[tauri::command]
pub fn system_prompt_set(
    app: AppHandle,
    state: State<'_, AppState>,
    custom_text: String,
    skill_links_text: String,
) -> Result<SystemPromptDto, AppError> {
    change_workspace_settings(&app, &state, |settings| {
        settings.system_prompt = SystemPromptSettings {
            custom_text,
            skill_links_text,
        };
    })?;
    sync_services_after_settings_change(&state)?;
    let settings = load_or_create_settings(&state.paths)?;
    Ok(SystemPromptDto::from(&settings.system_prompt))
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), AppError> {
    crate::process::open_in_browser(&url)
}

#[tauri::command]
pub fn set_workspace_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<StatusDto, AppError> {
    let canonical = validate_workspace_path(&path)?;
    change_workspace_settings(&app, &state, |settings| {
        settings.workspace_path = Some(canonical)
    })?;
    sync_services_after_settings_change(&state)?;
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn set_access_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<StatusDto, AppError> {
    let access_mode = AccessMode::parse(&mode)?;
    change_workspace_settings(&app, &state, |settings| settings.access_mode = access_mode)?;
    sync_services_after_settings_change(&state)?;
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn set_autostart(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<StatusDto, AppError> {
    set_autostart_enabled(&app, enabled)?;
    if enabled {
        let _ = state.start_if_configured()?;
    }
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn regenerate_mcp_url(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StatusDto, AppError> {
    state.regenerate_mcp_url()?;
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn enable_zrok(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<StatusDto, AppError> {
    state.enable_zrok(token)?;
    let _ = state.start_if_configured()?;
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn start_services(app: AppHandle, state: State<'_, AppState>) -> Result<StatusDto, AppError> {
    state.start()?;
    state.snapshot(autostart_enabled(&app))
}

#[tauri::command]
pub fn stop_services(app: AppHandle, state: State<'_, AppState>) -> Result<StatusDto, AppError> {
    state.stop()?;
    state.snapshot(autostart_enabled(&app))
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn autostart_enabled(_app: &AppHandle) -> bool {
    false
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn set_autostart_enabled(app: &AppHandle, enabled: bool) -> Result<(), AppError> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| AppError::new("autostart", error.to_string()))
    } else {
        manager
            .disable()
            .map_err(|error| AppError::new("autostart", error.to_string()))
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn set_autostart_enabled(_app: &AppHandle, _enabled: bool) -> Result<(), AppError> {
    Err(AppError::new(
        "autostart_unavailable",
        "Autostart is unavailable on this platform.",
    ))
}

// ---------------------------------------------------------------------------
// GitHub actions (For-AI/PLANNER/github-sync). Off by default.
//
// Note what is here and what is not. The desktop can enable the feature, bind a
// repository, review plans, approve and apply. A plan can also arrive from
// ChatGPT through the loopback broker - but github_approve is a Tauri command
// only. There is no broker route for it, so approval cannot be requested
// remotely by any caller, however the request is phrased.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn github_status(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
) -> Result<GitHubStatus, AppError> {
    coordinator.status()
}

#[tauri::command]
pub fn github_set_enabled(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    enabled: bool,
) -> Result<GitHubStatus, AppError> {
    coordinator.set_enabled(enabled)?;
    coordinator.status()
}

#[tauri::command]
pub fn github_bind(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    owner: String,
    repo: String,
    integration_branch: Option<String>,
) -> Result<GitHubStatus, AppError> {
    coordinator.bind(&owner, &repo, integration_branch)?;
    coordinator.status()
}

#[tauri::command]
pub fn github_unbind(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
) -> Result<GitHubStatus, AppError> {
    coordinator.unbind()?;
    coordinator.status()
}

#[tauri::command]
pub fn github_init_repository(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    initial_branch: Option<String>,
) -> Result<GitHubStatus, AppError> {
    coordinator.init_repository(initial_branch)?;
    coordinator.status()
}

/// Create a plan from the desktop. Shares the coordinator path the broker uses,
/// so both routes produce identically constrained plans.
#[tauri::command]
pub fn github_plan(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    action: String,
    paths: Vec<String>,
    message: Option<String>,
) -> Result<Plan, AppError> {
    let action = match action.as_str() {
        "commit" => PlanAction::Commit,
        "commit_push" => PlanAction::CommitPush,
        "push" => PlanAction::Push,
        other => {
            return Err(AppError::new(
                "unknown_action",
                format!("'{other}' is not a supported action."),
            ))
        }
    };
    coordinator.create_plan(action, paths, message)
}

/// Approve a plan. Deliberately desktop-only: this is the authorisation step,
/// and its absence from the broker is what makes the model unable to approve
/// its own proposals.
#[tauri::command]
pub fn github_approve(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    plan_id: String,
) -> Result<GitHubStatus, AppError> {
    coordinator.approve(&plan_id)?;
    coordinator.status()
}

#[tauri::command]
pub fn github_cancel(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    plan_id: String,
) -> Result<GitHubStatus, AppError> {
    coordinator.cancel(&plan_id)?;
    coordinator.status()
}

#[tauri::command]
pub fn github_apply(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    plan_id: String,
) -> Result<crate::github::operations::OperationReceipt, AppError> {
    coordinator.apply(&plan_id)
}

#[tauri::command]
pub fn github_operation_status(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    plan_id: String,
) -> Result<crate::github::operations::OperationReceipt, AppError> {
    coordinator.operation_status(&plan_id)
}

fn change_workspace_settings(
    app: &AppHandle,
    state: &AppState,
    edit: impl FnOnce(&mut crate::settings::Settings),
) -> Result<(), AppError> {
    let coordinator = app.state::<std::sync::Arc<GitHubCoordinator>>();
    coordinator.change_settings(|| {
        crate::actions::change_settings(app, || {
            let mut settings = load_or_create_settings(&state.paths)?;
            edit(&mut settings);
            save_settings(&state.paths, &settings)
        })
    })
}

fn sync_services_after_settings_change(state: &AppState) -> Result<(), AppError> {
    if std::env::var("SECRET_TUNNEL_ACTIONS_ONLY").as_deref() == Ok("1") {
        return Ok(());
    }
    if state.is_running()? {
        let _ = state.restart_if_configured()?;
    } else {
        let _ = state.start_if_configured()?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// GitHub account connection (OAuth device flow).
//
// The desktop never sees the user's GitHub password: GitHub authenticates the
// user in their own browser. These commands only start the flow, poll for its
// result, report state, and forget the token.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn github_account_status(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
) -> Result<crate::github::account::AccountState, AppError> {
    let paths = crate::settings::app_paths()?;
    let mut state = crate::github::account::state(&paths.config_dir);
    // The window needs both halves of the connected state in one read: who is
    // connected, and whether that connection authorises autonomous operation.
    state.autonomous = coordinator.authorization()?.autonomous;
    Ok(state)
}

/// Ask GitHub for a code and open the browser at its verification page. The
/// caller then polls; the code is shown in the window so the user can paste it.
#[tauri::command]
pub fn github_account_connect(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
) -> Result<crate::github::account::DeviceStart, AppError> {
    let start = crate::github::account::start(&coordinator.client_id()?)?;
    // The prefilled page, so approving is the only thing left to do. Best
    // effort: if the browser cannot be opened the window still shows the code.
    let _ = open_url(start.verification_uri_complete.clone());
    Ok(start)
}

#[tauri::command]
pub fn github_account_poll(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
    device_code: String,
) -> Result<crate::github::account::PollOutcome, AppError> {
    coordinator.adopt_connection(&device_code)
}

#[tauri::command]
pub fn github_account_disconnect(
    coordinator: State<'_, std::sync::Arc<GitHubCoordinator>>,
) -> Result<crate::github::account::AccountState, AppError> {
    let paths = crate::settings::app_paths()?;
    coordinator.forget_connection()?;
    Ok(crate::github::account::state(&paths.config_dir))
}
