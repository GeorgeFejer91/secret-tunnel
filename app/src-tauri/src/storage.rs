//! One Storage Box, configured locally. Only fixed file operations cross the
//! private loopback bridge; credentials and arbitrary commands never do.
use crate::{
    error::AppError,
    github::credential_store,
    settings::{self, AccessMode, AppPaths},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct StorageConfig {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub rclone_path: String,
    pub known_hosts_path: String,
    pub key_path: String,
    pub password: String,
    pub enabled: bool,
    pub read_write: bool,
    pub allow_transfers: bool,
    pub revision: String,
    pub tested_revision: Option<String>,
}
impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            user: String::new(),
            port: 23,
            rclone_path: String::new(),
            known_hosts_path: String::new(),
            key_path: String::new(),
            password: String::new(),
            enabled: false,
            read_write: false,
            allow_transfers: false,
            revision: uuid::Uuid::new_v4().simple().to_string(),
            tested_revision: None,
        }
    }
}
pub struct StorageState {
    paths: AppPaths,
    config_lock: Mutex<()>,
    busy: AtomicBool,
    stopped: AtomicBool,
    clients: AtomicUsize,
    instance: String,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn error(code: &'static str, message: &str) -> AppError {
    AppError::new(code, message)
}
/// Every failure code the worker is allowed to report. An error code is part of
/// the interface the caller branches on, so it is matched against this list
/// rather than forwarded: an unrecognised one becomes the generic failure
/// instead of inventing a code no caller knows.
const WORKER_CODES: &[&str] = &[
    "access_revoked",
    "authentication_or_permission",
    "denied_path",
    "destination_exists",
    "host_key_rejected",
    "invalid_authentication",
    "invalid_backend_result",
    "invalid_connection",
    "invalid_direction",
    "invalid_limit",
    "invalid_path",
    "invalid_range",
    "invalid_request_id",
    "invalid_root",
    "invalid_runtime",
    "invalid_text",
    "listing_changed",
    "local_policy_denied",
    "local_policy_unsupported",
    "local_root_denied",
    "not_editable",
    "not_file",
    "not_found",
    "not_text",
    "operation_cancelled",
    "operation_timeout",
    "parent_stopped",
    "precondition_required",
    "protected_path",
    "rclone_unavailable",
    "request_limit",
    "result_too_large",
    "source_changed",
    "storage_io",
    "unknown_operation",
    "unsafe_local_path",
    "unsafe_remote_path",
    "verification_failed",
    "write_conflict",
    "write_too_large",
];
fn worker_code(code: &str) -> &'static str {
    WORKER_CODES
        .iter()
        .copied()
        .find(|known| *known == code)
        .unwrap_or("storage_failure")
}
fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_id(id: &str) -> bool {
    (8..=80).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn atomic_private(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result: Result<(), AppError> = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
fn inside(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let p = path.to_string_lossy().to_lowercase();
        let r = root
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase();
        p == r || p.starts_with(&(r + "\\"))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}
impl StorageState {
    pub fn new(paths: AppPaths) -> Arc<Self> {
        Arc::new(Self {
            paths,
            config_lock: Mutex::new(()),
            busy: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            clients: AtomicUsize::new(0),
            instance: uuid::Uuid::new_v4().simple().to_string(),
        })
    }
    fn directory(&self) -> PathBuf {
        self.paths.config_dir.join("storage")
    }
    fn config_path(&self) -> PathBuf {
        self.directory().join("connection.json")
    }
    fn grant_path(&self) -> PathBuf {
        self.directory().join("grant")
    }
    fn job_path(&self, id: &str) -> Result<PathBuf, AppError> {
        if !valid_id(id) {
            return Err(error(
                "invalid_request_id",
                "Use a valid operation identifier.",
            ));
        }
        Ok(self.directory().join("jobs").join(format!("{id}.json")))
    }
    fn prepare(&self) -> Result<(), AppError> {
        fs::create_dir_all(self.directory().join("jobs"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.directory(), fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
    fn load(&self) -> Result<StorageConfig, AppError> {
        if !self.config_path().exists() {
            return Ok(StorageConfig::default());
        }
        Ok(serde_json::from_slice(&credential_store::decode(
            &fs::read(self.config_path())?,
        )?)?)
    }
    fn save(&self, c: &StorageConfig) -> Result<(), AppError> {
        self.prepare()?;
        // Fail closed if persisting the new settings fails part-way through.
        atomic_private(&self.grant_path(), b"revoked")?;
        atomic_private(
            &self.config_path(),
            &credential_store::encode(&serde_json::to_vec(c)?)?,
        )?;
        atomic_private(
            &self.grant_path(),
            format!("{}:{}", self.instance, c.revision).as_bytes(),
        )
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        let _ = atomic_private(&self.grant_path(), b"revoked");
    }
    fn write_mode(&self) -> bool {
        if std::env::var("SECRET_TUNNEL_ACCESS_MODE").as_deref() == Ok("read") {
            return false;
        }
        settings::load_settings(&self.paths)
            .ok()
            .flatten()
            .is_some_and(|s| s.access_mode == AccessMode::ReadWrite)
    }
    /// The roots a copy may touch, from the one shared resolver. Under a
    /// smart scope that is the approved subfolders and nothing else, so a
    /// transfer cannot reach a sibling the MCP config no longer exposes.
    fn selected(&self) -> Result<Vec<PathBuf>, AppError> {
        let s = settings::load_settings(&self.paths)?.unwrap_or_default();
        Ok(settings::effective_roots(&s)
            .unwrap_or_default()
            .iter()
            .filter_map(|r| fs::canonicalize(&r.root).ok())
            .collect())
    }
    fn roots(&self) -> Result<Vec<Value>, AppError> {
        let selected = self.selected()?;
        let document: Value = match fs::read(&self.paths.managed_config_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(_) => return Ok(vec![]),
        };
        Ok(document
            .get("repos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|r| {
                r.get("root")
                    .and_then(Value::as_str)
                    .and_then(|p| fs::canonicalize(p).ok())
                    .is_some_and(|p| selected.iter().any(|s| s == &p))
            })
            .cloned()
            .collect())
    }
    fn validate(&self, c: &StorageConfig) -> Result<(), AppError> {
        let base = c.user.split('-').next().unwrap_or("");
        let digits = base.strip_prefix('u').unwrap_or("");
        let suffix = c.user.strip_prefix(base).unwrap_or("");
        let sub = suffix.is_empty()
            || suffix
                .strip_prefix("-sub")
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if digits.is_empty()
            || !digits.bytes().all(|b| b.is_ascii_digit())
            || !sub
            || c.host != format!("{base}.your-storagebox.de")
            || ![22, 23].contains(&c.port)
        {
            return Err(error(
                "invalid_connection",
                "Use a matching Hetzner Storage Box hostname/account and port 22 or 23.",
            ));
        }
        if c.password.is_empty() == c.key_path.is_empty()
            || c.password.len() > 4096
            || c.password.contains(['\0', '\r', '\n'])
        {
            return Err(error(
                "invalid_authentication",
                "Choose password OR private-key authentication.",
            ));
        }
        let roots = self.selected()?;
        let profile = fs::canonicalize(&self.paths.config_dir)?;
        if roots.iter().any(|r| inside(&profile, r)) {
            return Err(error(
                "exposed_profile",
                "The Secret Tunnel profile must not be inside an exposed local folder.",
            ));
        }
        for value in [&c.rclone_path, &c.known_hosts_path, &c.key_path]
            .into_iter()
            .filter(|s| !s.is_empty())
        {
            let p = Path::new(value);
            let st = fs::symlink_metadata(p).map_err(|_| {
                error(
                    "missing_file",
                    "A configured executable, known_hosts or key file is missing.",
                )
            })?;
            if !p.is_absolute() || !st.is_file() || st.file_type().is_symlink() {
                return Err(error(
                    "invalid_file",
                    "Use absolute paths to regular files, not links.",
                ));
            }
            let canonical = fs::canonicalize(p)?;
            if roots.iter().any(|r| inside(&canonical, r)) {
                return Err(error(
                    "exposed_credential",
                    "Keep rclone, known_hosts and SSH keys outside all folders exposed to ChatGPT.",
                ));
            }
        }
        if Path::new(&c.rclone_path)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| ["cmd", "bat", "ps1"].contains(&s.to_ascii_lowercase().as_str()))
        {
            return Err(error(
                "invalid_executable",
                "Select the native rclone executable, not a shell script.",
            ));
        }
        Ok(())
    }
    fn status(&self, desktop: bool) -> Result<Value, AppError> {
        let c = self.load()?;
        let mut value = json!({"configured": !c.host.is_empty(), "enabled": c.enabled,
            "readWrite": c.read_write, "effectiveWrite": c.enabled && c.read_write && self.write_mode(),
            "allowTransfers": c.allow_transfers, "host": c.host, "user": c.user, "port": c.port,
            "revision": c.revision, "tested": c.tested_revision.as_deref() == Some(c.revision.as_str()),
            "scope": "account_root", "busy": self.busy.load(Ordering::Acquire),
            "credentialStorage": if cfg!(windows) { "windows_dpapi" } else { "private_file_unencrypted" },
            "localRoots": self.roots()?.iter().map(|r| json!({"repoId":r["repo_id"],"name":r["display_name"],"writable":r["writes"]["enabled"]})).collect::<Vec<_>>()});
        if desktop {
            value["rclonePath"] = json!(c.rclone_path);
            value["knownHostsPath"] = json!(c.known_hosts_path);
            value["keyPath"] = json!(c.key_path);
            value["passwordSaved"] = json!(!c.password.is_empty());
        }
        Ok(value)
    }
    fn worker(&self, c: &StorageConfig, operation: &str, input: &Value) -> Result<Value, AppError> {
        self.validate(c)?;
        let mut directories = vec![];
        if let Some(dir) = std::env::var_os("SECRET_TUNNEL_RESOURCE_DIR") {
            directories.push(PathBuf::from(dir));
        }
        directories.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = directories
            .iter()
            .map(|d| d.join("binaries").join(node_name))
            .find(|p| p.is_file())
            .ok_or_else(|| {
                error(
                    "storage_runtime_missing",
                    "Bundled Node is missing. Run prepare:runtime and rebuild.",
                )
            })?;
        let worker = directories
            .iter()
            .map(|d| d.join("storage/worker.mjs"))
            .chain(std::iter::once(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../storage/worker.mjs"),
            ))
            .find(|p| p.is_file())
            .ok_or_else(|| {
                error(
                    "storage_runtime_missing",
                    "The packaged storage worker is missing.",
                )
            })?;
        let selected = self.selected()?;
        for executable in [&node, &worker] {
            let canonical = fs::canonicalize(executable)?;
            if selected.iter().any(|root| inside(&canonical, root)) {
                return Err(error(
                    "exposed_runtime",
                    "Run the packaged storage runtime outside all folders exposed to ChatGPT.",
                ));
            }
        }
        let packet = json!({"config":c,"operation":operation,"input":input,"roots":self.roots()?,
            "protectedPaths":[self.paths.config_dir.to_string_lossy().to_string(),c.key_path.clone(),c.known_hosts_path.clone()],
            "grantFile":self.grant_path(),"revision":format!("{}:{}",self.instance,c.revision),
            "parentPid":std::process::id(),"settingsFile":self.paths.settings_path,
            "requireWrite":operation == "write" || operation == "copy"});
        let mut command = Command::new(node);
        command
            .arg(worker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            error(
                "storage_worker_failed",
                "The storage worker could not start.",
            )
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(&serde_json::to_vec(&packet)?).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error("storage_worker_failed", "The worker input failed."));
            }
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| error("storage_worker_failed", "No worker output pipe."))?;
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut bytes = vec![];
            let result = stdout.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes);
            let _ = sender.send((result, bytes));
        });
        let deadline = Duration::from_secs(if operation == "copy" { 90000 } else { 180 });
        let bytes = match receiver.recv_timeout(deadline) {
            Ok((Ok(_), bytes)) if bytes.len() <= 2 * 1024 * 1024 => bytes,
            _ => {
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let system =
                        std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
                    let _ = Command::new(PathBuf::from(system).join("System32/taskkill.exe"))
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(error("storage_worker_timeout", "Storage worker failed or exceeded its deadline/result limit. Inspect any write receipt."));
            }
        };
        let _ = child.wait();
        let response: Value = serde_json::from_slice(&bytes).map_err(|_| {
            error(
                "storage_worker_failed",
                "No valid worker result. A write outcome may be unknown.",
            )
        })?;
        if response["ok"] == true {
            Ok(response["value"].clone())
        } else {
            Err(error(
                worker_code(response["error"]["code"].as_str().unwrap_or_default()),
                response["error"]["message"]
                    .as_str()
                    .unwrap_or("Storage operation failed."),
            ))
        }
    }
    fn receipt(&self, id: &str) -> Result<Value, AppError> {
        let mut value: Value = serde_json::from_slice(
            &fs::read(self.job_path(id)?)
                .map_err(|_| error("unknown_job", "No receipt exists for this operation."))?,
        )?;
        if ["queued", "running"].contains(&value["state"].as_str().unwrap_or(""))
            && (value["instance"] != self.instance || !self.busy.load(Ordering::Acquire))
        {
            value["state"] = json!("outcome_unknown");
            value["message"] = json!("The desktop restarted. Inspect the destination; this request will not be automatically replayed.");
        }
        if let Some(object) = value.as_object_mut() {
            object.remove("inputHash");
            object.remove("instance");
        }
        Ok(value)
    }
    fn reserve(&self) -> Result<Busy<'_>, AppError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                error(
                    "storage_busy",
                    "A storage operation is already running. Check its receipt.",
                )
            })?;
        Ok(Busy(&self.busy))
    }
    pub fn request(self: &Arc<Self>, operation: &str, input: Value) -> Result<Value, AppError> {
        validate_request(operation, &input)?;
        if operation == "status" {
            return self.status(false);
        }
        if operation == "job" {
            return self.receipt(input["requestId"].as_str().unwrap_or(""));
        }
        let c = {
            let _lock = self
                .config_lock
                .lock()
                .map_err(|_| error("storage_lock", "Settings are unavailable."))?;
            self.load()?
        };
        if !c.enabled || self.stopped.load(Ordering::Acquire) {
            return Err(error(
                "storage_disabled",
                "Enable the Storage Box in the desktop tab first.",
            ));
        }
        if input["revision"].as_str() != Some(c.revision.as_str()) {
            return Err(error(
                "storage_revision_changed",
                "Read storage_status again; this grant changed.",
            ));
        }
        let mutation = operation == "write" || operation == "copy";
        if mutation && (!c.read_write || !self.write_mode()) {
            return Err(error(
                "storage_read_only",
                "Global and Storage Box read/write access must both be enabled.",
            ));
        }
        if operation == "copy" && !c.allow_transfers {
            return Err(error(
                "transfers_disabled",
                "Enable transfers with approved local folders in the Storage tab.",
            ));
        }
        if !mutation {
            let _busy = self.reserve()?;
            return self.worker(&c, operation, &input);
        }
        let id = input["requestId"].as_str().unwrap_or("").to_string();
        let receipt_path = self.job_path(&id)?;
        // The digest is a byte array rather than an integer, so "{:x}" does not
        // apply to it. Formatted by hand, as in github/coordinator.rs.
        let fingerprint: String = Sha256::digest(serde_json::to_vec(
            &json!({"operation":operation,"input":input}),
        )?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
        if receipt_path.exists() {
            let old: Value = serde_json::from_slice(&fs::read(&receipt_path)?)?;
            if old["inputHash"] != fingerprint {
                return Err(error(
                    "request_id_reused",
                    "This operation ID was used for different arguments.",
                ));
            }
            return self.receipt(&id);
        }
        let busy = self.reserve()?;
        self.prepare()?;
        let mut receipt = json!({"requestId":id,"state":"queued","operation":operation,
            "createdAt":timestamp(),"updatedAt":timestamp(),"instance":self.instance,"inputHash":fingerprint,
            "path":input.get("path").or_else(|| input.get("remotePath"))});
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&receipt_path).map_err(|_| {
            error(
                "job_conflict",
                "The job ID is already reserved or its receipt cannot be written.",
            )
        })?;
        file.write_all(&serde_json::to_vec(&receipt)?)?;
        file.sync_all()?;
        drop(file);
        let state = self.clone();
        let op = operation.to_string();
        std::mem::forget(busy); // The spawned task owns release of this one-operation guard.
        let spawn_result = thread::Builder::new()
            .name("storage-transfer".into())
            .spawn(move || {
                let _busy = Busy(&state.busy);
                receipt["state"] = json!("running");
                receipt["updatedAt"] = json!(timestamp());
                let result = (|| {
                    atomic_private(&receipt_path, &serde_json::to_vec(&receipt)?)?;
                    state.worker(&c, &op, &input)
                })();
                receipt["updatedAt"] = json!(timestamp());
                match result {
                    Ok(result) => {
                        receipt["state"] = json!("completed");
                        receipt["result"] = result;
                    }
                    Err(e) => {
                        receipt["state"] = json!("outcome_unknown");
                        receipt["error"] = json!({"code":e.code,"message":e.message});
                    }
                }
                if let Ok(bytes) = serde_json::to_vec(&receipt) {
                    let _ = atomic_private(&receipt_path, &bytes);
                }
            });
        if spawn_result.is_err() {
            self.busy.store(false, Ordering::Release);
            return Err(error(
                "storage_worker_failed",
                "The transfer worker could not start. No automatic retry was made.",
            ));
        }
        self.receipt(&id)
    }
    fn desktop(self: &Arc<Self>, action: &str, input: Value) -> Result<Value, AppError> {
        if action == "status" {
            return self.status(true);
        }
        if action == "pick" {
            return Ok(json!(rfd::FileDialog::new()
                .pick_file()
                .map(|p| p.to_string_lossy().to_string())));
        }
        if ["list", "read", "write", "copy", "job"].contains(&action) {
            return self.request(action, input);
        }
        let _lock = self
            .config_lock
            .lock()
            .map_err(|_| error("storage_lock", "Settings are unavailable."))?;
        let mut c = self.load()?;
        match action {
            "save" => {
                let previous = c.clone();
                c = serde_json::from_value(input)
                    .map_err(|_| error("invalid_settings", "Invalid Storage Box settings."))?;
                if c.password.is_empty()
                    && c.key_path.is_empty()
                    && c.host == previous.host
                    && c.user == previous.user
                {
                    c.password = previous.password;
                }
                c.enabled = false;
                c.revision = uuid::Uuid::new_v4().simple().to_string();
                c.tested_revision = None;
                self.validate(&c)?;
                self.save(&c)?;
            }
            "test" => {
                let _busy = self.reserve()?;
                self.validate(&c)?;
                c.enabled = false;
                c.tested_revision = None;
                self.save(&c)?;
                let value = self.worker(&c, "test", &json!({}))?;
                c.tested_revision = Some(c.revision.clone());
                self.save(&c)?;
                return Ok(value);
            }
            "enable" => {
                if c.tested_revision.as_deref() != Some(c.revision.as_str()) {
                    return Err(error(
                        "test_required",
                        "Test the saved connection before enabling ChatGPT access.",
                    ));
                }
                self.validate(&c)?;
                c.enabled = true;
                self.save(&c)?;
            }
            "disable" => {
                c.enabled = false;
                c.revision = uuid::Uuid::new_v4().simple().to_string();
                c.tested_revision = None;
                self.save(&c)?;
            }
            _ => {
                return Err(error(
                    "unknown_action",
                    "Unsupported storage configuration action.",
                ))
            }
        }
        self.status(true)
    }
    pub fn start_broker(self: &Arc<Self>) -> Result<(), AppError> {
        std::env::remove_var("SECRET_TUNNEL_STORAGE_URL");
        std::env::remove_var("SECRET_TUNNEL_STORAGE_TOKEN");
        self.prepare()?;
        let c = self.load()?;
        atomic_private(
            &self.grant_path(),
            format!("{}:{}", self.instance, c.revision).as_bytes(),
        )?;
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        std::env::set_var(
            "SECRET_TUNNEL_STORAGE_URL",
            format!("http://{}", listener.local_addr()?),
        );
        std::env::set_var("SECRET_TUNNEL_STORAGE_TOKEN", &token);
        let state = self.clone();
        thread::spawn(move || {
            while !state.stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if state.clients.fetch_add(1, Ordering::AcqRel) >= 8 {
                            state.clients.fetch_sub(1, Ordering::AcqRel);
                            continue;
                        }
                        let s = state.clone();
                        let t = token.clone();
                        thread::spawn(move || {
                            let _ = serve(stream, &t, &s);
                            s.clients.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }
}
fn validate_request(op: &str, value: &Value) -> Result<(), AppError> {
    let allowed: &[&str] = match op {
        "status" => &[],
        "job" => &["requestId"],
        "list" => &["revision", "path", "offset", "limit", "snapshot"],
        "read" => &["revision", "path", "offset", "maxBytes"],
        "write" => &["revision", "path", "content", "expectedSha256", "requestId"],
        "copy" => &[
            "revision",
            "direction",
            "repoId",
            "localPath",
            "remotePath",
            "requestId",
        ],
        _ => return Err(error("unknown_operation", "Unsupported storage operation.")),
    };
    let object = value
        .as_object()
        .ok_or_else(|| error("invalid_request", "Expected a JSON object."))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(error("unknown_field", "Unexpected storage argument."));
    }
    Ok(())
}
fn serve(mut stream: TcpStream, token: &str, state: &Arc<StorageState>) -> Result<(), AppError> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.by_ref().take(8193).read_line(&mut line)?;
    let parts: Vec<_> = line.split_whitespace().collect();
    if line.len() > 8192 || parts.len() != 3 || parts[0] != "POST" {
        return respond(
            &mut stream,
            400,
            json!({"error":{"code":"bad_request","message":"POST JSON required."}}),
        );
    }
    let operation = parts[1].strip_prefix('/').unwrap_or("").to_string();
    let mut length = None;
    let mut auth = None;
    let mut bad = false;
    let mut done = false;
    let mut bytes = 0;
    let mut length_seen = false;
    for _ in 0..64 {
        let mut h = String::new();
        reader.by_ref().take(8193).read_line(&mut h)?;
        bytes += h.len();
        if h.len() > 8192 || bytes > 32768 {
            bad = true;
            break;
        }
        if h == "\r\n" || h == "\n" {
            done = true;
            break;
        }
        if let Some((name, value)) = h.split_once(':') {
            match name.to_ascii_lowercase().as_str() {
                "authorization" => {
                    if auth.is_some() {
                        bad = true;
                    }
                    auth = Some(value.trim().to_string());
                }
                "content-length" => {
                    if length_seen {
                        bad = true;
                    }
                    length_seen = true;
                    length = value.trim().parse::<usize>().ok();
                    if length.is_none() {
                        bad = true;
                    }
                }
                "origin" | "transfer-encoding" => bad = true,
                _ => (),
            }
        } else {
            bad = true;
        }
    }
    let expected = format!("Bearer {token}");
    let supplied = auth.unwrap_or_default();
    let authorized = supplied.len() == expected.len()
        && supplied
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |v, (a, b)| v | (a ^ b))
            == 0;
    if bad || !done || !authorized {
        return respond(
            &mut stream,
            403,
            json!({"error":{"code":"forbidden","message":"Forbidden."}}),
        );
    }
    let length = length
        .filter(|n| *n <= 1024 * 1024)
        .ok_or_else(|| error("request_limit", "Invalid request length."))?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let result = serde_json::from_slice::<Value>(&body)
        .map_err(|_| error("invalid_json", "Invalid JSON."))
        .and_then(|v| state.request(&operation, v));
    match result {
        Ok(v) => respond(&mut stream, 200, v),
        Err(e) => respond(
            &mut stream,
            400,
            json!({"error":{"code":e.code,"message":e.message}}),
        ),
    }
}
fn respond(stream: &mut TcpStream, status: u16, value: Value) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(&value)?;
    write!(stream,"HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",if status == 200 {"OK"} else {"Error"},bytes.len())?;
    stream.write_all(&bytes)?;
    Ok(())
}
#[tauri::command]
pub async fn storage_request(
    state: tauri::State<'_, Arc<StorageState>>,
    action: String,
    input: Value,
) -> Result<Value, AppError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.desktop(&action, input))
        .await
        .map_err(|_| error("storage_task_failed", "Storage task failed."))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_grant_nothing() {
        let c = StorageConfig::default();
        assert!(!c.enabled && !c.read_write && !c.allow_transfers);
    }
    #[test]
    fn job_ids_are_not_paths() {
        assert!(valid_id("copy-12345678"));
        assert!(!valid_id("../../secret"));
    }
    #[test]
    fn operation_surface_is_closed() {
        assert!(validate_request("shell", &json!({})).is_err());
        assert!(validate_request("read", &json!({"path":"x","host":"evil"})).is_err());
        assert!(validate_request("read", &json!({"path":"x","revision":"v"})).is_ok());
    }
}
