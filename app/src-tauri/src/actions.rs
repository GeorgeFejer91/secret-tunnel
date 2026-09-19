use crate::error::AppError;
use crate::process::AppState;
use crate::settings::{load_or_create_settings, validate_workspace_path, AppPaths};
use fs4::fs_std::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const VEHICLE: &str = include_str!("../../scripts/action-vehicle.mjs");
const MAX_REPLY: u64 = 2 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct ActionsState {
    worker: Arc<Mutex<Option<Worker>>>,
}

struct Worker {
    workspace: String,
    child: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
    _job: execution_job::Job,
    _workspace_lock: File,
}

impl Worker {
    fn start(paths: &AppPaths, workspace: &str) -> Result<Self, AppError> {
        let source = Path::new(workspace).canonicalize()?;
        fs::create_dir_all(&paths.config_dir)?;
        let config = paths.config_dir.canonicalize()?;
        if config.starts_with(&source) || source.starts_with(&config) {
            return Err(AppError::new(
                "actions_store",
                "Action control storage must be outside the shared folder.",
            ));
        }
        let workspace_lock = acquire_workspace_lock(&source)?;
        let runtime_dir = config.join("action-runtime");
        fs::create_dir_all(&runtime_dir)?;
        if fs::symlink_metadata(&runtime_dir)?.file_type().is_symlink() {
            return Err(AppError::new(
                "actions_runtime",
                "Action runtime directory cannot be a link.",
            ));
        }
        // sha2's digest() returns a GenericArray, which has no LowerHex impl,
        // so "{:x}" does not apply to it. Formatted by hand to match
        // workspace_fingerprint and content_digest in github/coordinator.rs.
        let hash: String = Sha256::digest(VEHICLE.as_bytes())
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let script = runtime_dir.join(format!("vehicle-{hash}.mjs"));
        install_vehicle(&script)?;
        let node = crate::process::bundled_executable("node").ok_or_else(|| {
            AppError::new(
                "actions_node",
                "Bundled Node is missing. Reinstall Secret Tunnel.",
            )
        })?;
        let mut command = Command::new(node);
        // The action worker runs unattended; no console window for it either.
        crate::process::suppress_console_window(&mut command);
        command
            .arg(&script)
            .arg("--worker")
            .current_dir(&config)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (name, value) in std::env::vars_os() {
            if allowed_environment(&name.to_string_lossy()) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let job = match execution_job::Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("actions_pipe", "Cannot open action input."))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("actions_pipe", "Cannot open action output."))?;
        let (sender, replies) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut bytes = Vec::new();
                let read = Read::by_ref(&mut reader)
                    .take(MAX_REPLY + 1)
                    .read_until(b'\n', &mut bytes);
                match read {
                    Ok(0) => break,
                    Ok(_) if bytes.len() as u64 <= MAX_REPLY && bytes.last() == Some(&b'\n') => {
                        let result = serde_json::from_slice(&bytes).map_err(|e| e.to_string());
                        if sender.send(result).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = sender.send(Err(
                            "Action response exceeded its bound or was interrupted.".into(),
                        ));
                        break;
                    }
                }
            }
        });
        let mut worker = Self {
            workspace: workspace.to_owned(),
            child,
            input,
            replies,
            next_id: 0,
            _job: job,
            _workspace_lock: workspace_lock,
        };
        worker.request(
            "init",
            json!({"workspace": workspace, "private_root": config.join("actions-local")}),
        )?;
        Ok(worker)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        if self.child.try_wait()?.is_some() {
            return Err(AppError::new("actions_stopped", "Action runner stopped. Close and reopen Actions; interrupted work is never replayed."));
        }
        self.next_id += 1;
        let message =
            serde_json::to_vec(&json!({"id": self.next_id, "method": method, "params": params}))?;
        if message.len() > 262144 {
            return Err(AppError::new(
                "actions_request",
                "Action request is too large.",
            ));
        }
        self.input.write_all(&message)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        let response = self.replies.recv_timeout(Duration::from_secs(15))
            .map_err(|_| AppError::new("actions_timeout", "No bounded response from the action runner. Work may have started; do not retry blindly."))?
            .map_err(|message| AppError::new("actions_protocol", message))?;
        if response["id"].as_u64() != Some(self.next_id) {
            return Err(AppError::new(
                "actions_protocol",
                "Mismatched action response. Restart Actions before continuing.",
            ));
        }
        if response["ok"].as_bool() != Some(true) {
            return Err(AppError::new(
                "actions_rejected",
                response["error"]["message"]
                    .as_str()
                    .unwrap_or("Action request was rejected."),
            ));
        }
        Ok(response["result"].clone())
    }

    fn shutdown(&mut self) {
        let _ = self.request("shutdown", json!({}));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn acquire_workspace_lock(source: &Path) -> Result<File, AppError> {
    let mut current = source.to_path_buf();
    for part in [".chatgpt", "actions"] {
        current.push(part);
        if !current.exists() {
            match fs::create_dir(&current) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error.into()),
            }
        }
        let metadata = fs::symlink_metadata(&current)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !current.canonicalize()?.starts_with(source)
        {
            return Err(AppError::new(
                "actions_lock",
                "Action control directory is unsafe.",
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(AppError::new(
                    "actions_lock",
                    "Action control directory cannot be a reparse point.",
                ));
            }
        }
    }
    let lock_path = current.join("controller.lock");
    if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::new(
                "actions_lock",
                "Action lock is not a regular file.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                return Err(AppError::new(
                    "actions_lock",
                    "Action lock cannot have multiple links.",
                ));
            }
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(&lock_path).map_err(|error| {
        AppError::new(
            "actions_lock",
            format!("Cannot own the action queue. Another profile may already own it: {error}"),
        )
    })?;
    match FileExt::try_lock_exclusive(&file) {
        Ok(true) => Ok(file),
        Ok(false) => Err(AppError::new(
            "actions_lock",
            "Another desktop profile owns this workspace's action queue.",
        )),
        Err(error) => Err(AppError::new("actions_lock", error.to_string())),
    }
}

fn install_vehicle(script: &Path) -> Result<(), AppError> {
    if let Ok(metadata) = fs::symlink_metadata(script) {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || fs::read(script)? != VEHICLE.as_bytes()
        {
            return Err(AppError::new("actions_runtime", "Embedded action runtime was modified. Reinstall or remove the damaged private runtime file locally."));
        }
        return Ok(());
    }
    let temporary = script.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(VEHICLE.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, script)?;
    Ok(())
}

fn allowed_environment(name: &str) -> bool {
    matches!(
        name.to_ascii_uppercase().as_str(),
        "PATH"
            | "SYSTEMROOT"
            | "WINDIR"
            | "TEMP"
            | "TMP"
            | "TMPDIR"
            | "HOME"
            | "USERPROFILE"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "LANG"
            | "LC_ALL"
            | "PATHEXT"
    )
}

/// Holds the local worker slot while a typed GitHub operation is executing.
/// An idle worker may be closed; prepare_switch refuses active or approved work.
pub(crate) struct GitHubReservation<'a> {
    _guard: std::sync::MutexGuard<'a, Option<Worker>>,
}

impl ActionsState {
    pub(crate) fn reserve_for_github(&self) -> Result<GitHubReservation<'_>, AppError> {
        let mut guard = self
            .worker
            .try_lock()
            .map_err(|_| AppError::new("actions_busy", "The Actions interface is busy."))?;
        if let Some(worker) = guard.as_mut() {
            worker.request("prepare_switch", json!({}))?;
            worker.shutdown();
        }
        *guard = None;
        Ok(GitHubReservation { _guard: guard })
    }

    fn request(&self, paths: &AppPaths, method: &str, params: Value) -> Result<Value, AppError> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|_| AppError::new("actions_lock", "Action controller lock failed."))?;
        let settings = load_or_create_settings(paths)?;
        // The worker holds the whole primary folder and executes inside it,
        // which is precisely what a smart scope withholds. Refused rather than
        // pointed at a subfolder it was never designed for.
        crate::smart_folders::guard_broad_capability(&settings)?;
        let workspace = settings.workspace_path.as_deref().ok_or_else(|| {
            AppError::new(
                "actions_folder",
                "Select a project folder in the main window first.",
            )
        })?;
        let workspace = validate_workspace_path(workspace)?;
        if let Some(worker) = guard.as_mut() {
            if worker.child.try_wait()?.is_some() {
                *guard = None;
            }
        }
        if let Some(worker) = guard.as_mut() {
            if worker.workspace != workspace {
                worker.request("prepare_switch", json!({}))?;
                worker.shutdown();
                *guard = None;
            }
        }
        if guard.is_none() {
            *guard = Some(Worker::start(paths, &workspace)?);
        }
        let result = guard
            .as_mut()
            .ok_or_else(|| AppError::new("actions_stopped", "Action runner is not available."))?
            .request(method, params);
        if result.as_ref().err().is_some_and(|e| {
            matches!(
                e.code,
                "actions_timeout" | "actions_protocol" | "actions_stopped" | "io"
            )
        }) {
            *guard = None;
        }
        result
    }

    fn change_settings<T>(
        &self,
        save: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|_| AppError::new("actions_lock", "Action controller lock failed."))?;
        if let Some(worker) = guard.as_mut() {
            worker.request("prepare_switch", json!({}))?;
            worker.shutdown();
        }
        *guard = None;
        save()
    }

    pub fn stop_all(&self) {
        if let Ok(mut guard) = self.worker.lock() {
            if let Some(worker) = guard.as_mut() {
                worker.shutdown();
            }
            *guard = None;
        }
    }
}

pub fn change_settings<T>(
    app: &AppHandle,
    save: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    app.state::<ActionsState>().change_settings(save)
}

fn local_window(window: &WebviewWindow, label: &str) -> Result<(), AppError> {
    if window.label() != label {
        return Err(AppError::new(
            "actions_origin",
            "This action requires the local Actions interface.",
        ));
    }
    let url = window
        .url()
        .map_err(|e| AppError::new("actions_origin", e.to_string()))?;
    let host = url.host_str().unwrap_or_default();
    let packaged = (url.scheme() == "tauri" && host == "localhost")
        || (matches!(url.scheme(), "http" | "https") && host == "tauri.localhost");
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(host, "localhost" | "127.0.0.1" | "[::1]")
        && url.port() == Some(1420);
    if !(packaged || development) {
        return Err(AppError::new(
            "actions_origin",
            "Remote pages cannot authorize local actions.",
        ));
    }
    let expected = if label == "actions" {
        "/actions.html"
    } else {
        "/index.html"
    };
    if url.path() != expected && !(label == "main" && url.path() == "/") {
        return Err(AppError::new(
            "actions_origin",
            "Unexpected action window document.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn open_actions(window: WebviewWindow, app: AppHandle) -> Result<(), AppError> {
    local_window(&window, "main")?;
    if let Some(existing) = app.get_webview_window("actions") {
        existing
            .show()
            .map_err(|e| AppError::new("actions_window", e.to_string()))?;
        existing
            .set_focus()
            .map_err(|e| AppError::new("actions_window", e.to_string()))?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "actions",
        WebviewUrl::App(PathBuf::from("actions.html")),
    )
    .title("Secret Tunnel · Actions")
    .inner_size(920.0, 760.0)
    .min_inner_size(640.0, 480.0)
    .on_navigation(|url| {
        let host = url.host_str().unwrap_or_default();
        (url.scheme() == "tauri" && host == "localhost")
            || (matches!(url.scheme(), "http" | "https") && host == "tauri.localhost")
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && matches!(host, "localhost" | "127.0.0.1")
                && url.port() == Some(1420))
    })
    .build()
    .map_err(|e| AppError::new("actions_window", e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn actions_request(
    window: WebviewWindow,
    state: State<'_, AppState>,
    actions: State<'_, ActionsState>,
    method: String,
    params: Value,
) -> Result<Value, AppError> {
    local_window(&window, "actions")?;
    if !matches!(
        method.as_str(),
        "list"
            | "initialize"
            | "detail"
            | "approve"
            | "reject"
            | "pause"
            | "resume"
            | "cancel"
            | "auto_checks"
    ) {
        return Err(AppError::new(
            "actions_request",
            "This operation is not available to the interface.",
        ));
    }
    let paths = state.paths.clone();
    let actions = actions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions.request(&paths, &method, params))
        .await
        .map_err(|e| AppError::new("actions_worker", e.to_string()))?
}

#[cfg(windows)]
pub(crate) mod execution_job {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub struct Job(Handle);
    unsafe impl Send for Job {}
    impl Job {
        pub fn attach(child: &Child) -> Result<Self, AppError> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(AppError::new(
                    "actions_job",
                    "Cannot create the execution job.",
                ));
            }
            let job = Self(handle);
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x00002000;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                )
            };
            let assigned = configured != 0
                && unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as Handle) }
                    != 0;
            if !assigned {
                return Err(AppError::new(
                    "actions_job",
                    "Cannot contain the execution job; no actions were authorized.",
                ));
            }
            Ok(job)
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
#[cfg(not(windows))]
pub(crate) mod execution_job {
    use super::*;
    pub struct Job;
    impl Job {
        pub fn attach(_child: &Child) -> Result<Self, AppError> {
            Ok(Self)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn action_environment_excludes_credentials_and_startup_injection() {
        for name in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "BASH_ENV",
            "ZROK_ENABLE_TOKEN",
            "SECRET_TUNNEL_ZROK_ENABLE_TOKEN",
        ] {
            assert!(!allowed_environment(name));
        }
        for name in ["PATH", "Path", "SystemRoot", "TEMP", "HOME"] {
            assert!(allowed_environment(name));
        }
    }
    #[test]
    fn vehicle_is_embedded_and_not_loaded_from_the_workspace() {
        assert!(VEHICLE.contains("export class ActionsController"));
        assert!(VEHICLE.contains("checks_policy"));
        assert!(!VEHICLE.is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn windows_job_terminates_a_real_child_on_drop() {
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 > nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let job = execution_job::Job::attach(&child).unwrap();
        drop(job);
        for _ in 0..100 {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("Execution job did not terminate its child.");
    }
}

#[cfg(test)]
mod workspace_lock_tests {
    use super::*;

    #[test]
    fn lock_is_exclusive_and_released_without_deleting_the_file() {
        let root = std::env::temp_dir().join(format!("st-action-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let first = acquire_workspace_lock(&root).unwrap();
        assert!(acquire_workspace_lock(&root).is_err());
        drop(first);
        let next = acquire_workspace_lock(&root).unwrap();
        drop(next);
        assert!(root.join(".chatgpt/actions/controller.lock").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lock_rejects_linked_control_directory() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("st-action-link-{}", uuid::Uuid::new_v4()));
        let root = base.join("workspace");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".chatgpt")).unwrap();
        assert!(acquire_workspace_lock(&root).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
