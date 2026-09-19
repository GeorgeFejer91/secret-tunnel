use crate::error::AppError;
use crate::system_prompt::SystemPromptSettings;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use uuid::Uuid;

/// The product line this installation belongs to. It is part of the on-disk
/// profile path, so every generation keeps a profile of its own and a frozen
/// older install goes on using the one it was set up with.
const APPLICATION: &str = "Secret Tunnel v4";

/// The generation before this one, whose profile a first run copies from.
const PREVIOUS_APPLICATION: &str = "Secret Tunnel v3";

#[derive(Clone)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub settings_path: PathBuf,
    pub managed_config_path: PathBuf,
    pub diagnostics_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    Read,
    ReadWrite,
}

impl AccessMode {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "read" => Ok(Self::Read),
            "read_write" => Ok(Self::ReadWrite),
            _ => Err(AppError::new(
                "invalid_access_mode",
                "Choose either read or read+write.",
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::ReadWrite => "read_write",
        }
    }
}

/// How a mutation is authorised. Only local desktop approval exists, and the
/// enum is stored so a future mode cannot be introduced by a settings file that
/// simply omits the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    #[serde(rename = "local_approval", alias = "local")]
    Local,
    /// Granting this mode is the authorisation. A plan that passes every other
    /// check runs without a per-operation desktop click. Defaults to `Local`,
    /// so a settings file that omits the field is never autonomous.
    Autonomous,
}

impl ApprovalMode {
    pub fn is_autonomous(self) -> bool {
        matches!(self, ApprovalMode::Autonomous)
    }
}

impl Default for ApprovalMode {
    fn default() -> Self {
        Self::Local
    }
}

/// Which GitHub repository the selected folder is bound to.
///
/// `workspace_fingerprint` is the canonical identity of the folder this binding
/// was made for. Selecting a different folder must not inherit the previous
/// binding, so the fingerprint is compared rather than trusted.
///
/// `repository_id` is GitHub's immutable numeric id. Owner and repo names can
/// both be renamed and reused by someone else, so the id is what actually
/// identifies the repository when it is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBinding {
    pub workspace_fingerprint: String,
    #[serde(default = "default_github_host")]
    pub host: String,
    pub owner: String,
    pub repo: String,
    #[serde(default)]
    pub repository_id: Option<u64>,
    #[serde(default = "default_integration_branch")]
    pub integration_branch: String,
    /// Display cache only. Never treated as proof that Pages is configured.
    #[serde(default)]
    pub pages_url: Option<String>,
    /// The custom Pages domain this app itself configured for this exact
    /// repository. It is the only non-default origin the Pages verifier will
    /// accept, so it is written solely by `ensure_pages` after GitHub has
    /// confirmed the domain, never from a caller-supplied value.
    #[serde(default)]
    pub pages_domain: Option<String>,
}

/// GitHub feature configuration.
///
/// Credentials are deliberately absent. Tokens live in the OS credential store
/// reached through the account service, never in this file, which is plain JSON
/// inside the profile directory and is read by status paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSettings {
    /// Off unless the user turns it on. An installation that has never seen
    /// this feature must behave exactly as it did before.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub binding: Option<RepositoryBinding>,
    #[serde(default)]
    pub approval_mode: ApprovalMode,
}

impl Default for GitHubSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            binding: None,
            approval_mode: ApprovalMode::Local,
        }
    }
}

impl GitHubSettings {
    /// True when the feature is on *and* bound to the folder currently
    /// selected. A binding made for another folder is inert rather than an
    /// error: the user may switch back to it later.
    ///
    /// Called by the GitHub coordinator's status path, which is still being
    /// wired; the T01 tests exercise it in the meantime.
    #[allow(dead_code)]
    pub fn is_active_for(&self, workspace_fingerprint: &str) -> bool {
        self.enabled
            && self
                .binding
                .as_ref()
                .is_some_and(|binding| binding.workspace_fingerprint == workspace_fingerprint)
    }
}

/// One approved concrete match: the registered project it was found in, and
/// the exact immediate child directory inside it.
///
/// Both paths are stored, not a pattern. A pattern would keep matching folders
/// that appear later; these two strings only ever name a directory the person
/// actually previewed and approved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolderMatch {
    pub project: String,
    pub folder: String,
}

/// The active Smart folders restriction.
///
/// `None` on `Settings` is the ordinary behaviour every installation has had:
/// the whole primary folder and every extra folder. `Some` replaces the roots
/// this endpoint serves with exactly `matches`, and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartScope {
    /// The folder name as the person chose it, kept for display. Authorisation
    /// is decided by `matches`, never by re-running this name against the disk.
    pub name: String,
    #[serde(default)]
    pub matches: Vec<SmartFolderMatch>,
}

/// One root the MCP config actually exposes, whichever mode produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveRoot {
    pub repo_id: String,
    pub display_name: String,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default = "default_access_mode")]
    pub access_mode: AccessMode,
    #[serde(default = "default_zrok_name")]
    pub zrok_name: String,
    #[serde(default = "default_public_path_token")]
    pub public_path_token: String,
    #[serde(default = "default_gpt_repo_mcp_path")]
    pub gpt_repo_mcp_path: String,
    /// Absent in every settings file written before this feature existed, which
    /// is why it defaults rather than failing to parse.
    #[serde(default)]
    pub github: GitHubSettings,
    /// Further folders exposed alongside `workspace_path`, which stays the one
    /// the GitHub binding and the actions framework are anchored to. Keeping a
    /// single primary is what lets extra folders be added without touching any
    /// of that: they only ever add roots to the MCP config.
    #[serde(default)]
    pub extra_folders: Vec<String>,
    /// What the user typed into the System Prompt tab. The built-in paragraph
    /// is not here on purpose: it is the app describing itself, so a stored
    /// copy would only go stale against the build that reads it.
    #[serde(default)]
    pub system_prompt: SystemPromptSettings,
    /// The Folders tab's Smart folders section. Absent in every settings file
    /// written before it existed, which is why it defaults rather than failing
    /// to parse - and `None` is exactly the behaviour those files already had.
    #[serde(default)]
    pub smart_scope: Option<SmartScope>,
}

impl Settings {
    fn normalize(mut self) -> Self {
        if self.version == 0 {
            self.version = default_version();
        }
        self.workspace_path = self
            .workspace_path
            .map(|path| normalize_windows_verbatim_prefix(&path));
        if self.zrok_name.trim().is_empty() {
            self.zrok_name = default_zrok_name();
        }
        if self.public_path_token.trim().is_empty() {
            self.public_path_token = default_public_path_token();
        }
        if self.gpt_repo_mcp_path.trim().is_empty() {
            self.gpt_repo_mcp_path = default_gpt_repo_mcp_path();
        }
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: default_version(),
            workspace_path: None,
            access_mode: default_access_mode(),
            zrok_name: default_zrok_name(),
            public_path_token: default_public_path_token(),
            gpt_repo_mcp_path: default_gpt_repo_mcp_path(),
            github: GitHubSettings::default(),
            extra_folders: Vec::new(),
            system_prompt: SystemPromptSettings::default(),
            smart_scope: None,
        }
    }
}

pub fn app_paths() -> Result<AppPaths, AppError> {
    let config_dir = match config_dir_override()? {
        Some(dir) => dir,
        None => {
            let dirs = ProjectDirs::from("com", "GeorgeFejer", APPLICATION).ok_or_else(|| {
                AppError::new("app_data", "Could not resolve app data directory.")
            })?;
            let dir = dirs.config_dir().to_path_buf();
            seed_from_previous_generation(&dir);
            dir
        }
    };
    fs::create_dir_all(&config_dir).map_err(|_| {
        AppError::new(
            "config_dir_unavailable",
            "The application configuration directory cannot be created or written.",
        )
    })?;
    Ok(paths_in(config_dir))
}

/// The files that make up a profile, given the directory holding it.
fn paths_in(config_dir: PathBuf) -> AppPaths {
    AppPaths {
        settings_path: config_dir.join("settings.json"),
        managed_config_path: config_dir.join("gpt-repo-mcp.config.json"),
        diagnostics_path: config_dir.join("diagnostics.log"),
        config_dir,
    }
}

/// What carries from one generation's profile into the next.
///
/// An allowlist, not a denylist. These three are the setup a person did by
/// hand - which folder, which access mode, which GitHub account, which zrok
/// enrolment - and everything else in a profile is state belonging to the
/// installation that wrote it: its lock, its owner metadata, its diagnostics
/// log, its action inbox, its operation ledgers. A file added to the profile
/// later is far likelier to be state than setup, so "does not carry" is the
/// safe default to have.
///
/// `gpt-repo-mcp.config.json` is deliberately absent: it is derived from
/// settings and rewritten on every start.
const CARRIED_PROFILE_ENTRIES: [&str; 3] = ["settings.json", "github-account.json", "zrok-home"];

/// Carry the previous generation's profile into this one, once.
///
/// The profile directory is named after the product line, so v3 starts with an
/// empty one: no workspace folder, no zrok enrolment, no GitHub account. That
/// is a setup the person already did once, so the first run copies v2's across
/// - by copying, never moving, so the v2 install it came from still works
/// exactly as it did. Same reasoning, and same shape, as the zrok home seeding
/// in `process::prepare_zrok_home`.
///
/// It runs only when this generation has no settings file of its own, so it
/// can never overwrite something v3 has written, and it stops being reachable
/// work the moment v3 has saved anything.
///
/// Only the default profile is seeded. A `SECRET_TUNNEL_CONFIG_DIR` override is
/// an isolated profile - the smoke harness depends on it starting empty.
fn seed_from_previous_generation(config_dir: &Path) {
    if config_dir.join("settings.json").is_file() {
        return;
    }
    let Some(previous) = ProjectDirs::from("com", "GeorgeFejer", PREVIOUS_APPLICATION) else {
        return;
    };
    let previous = previous.config_dir().to_path_buf();
    if !previous.join("settings.json").is_file() || previous == config_dir {
        return;
    }
    carry_profile(&previous, config_dir);
}

/// Copy a profile forward onto its own public address.
///
/// The two generations must not claim one endpoint. `zrok_name` is a name
/// reserved with the zrok service, and the stale-share cleanup deletes every
/// share published under the name it is starting with - right for debris left
/// by a killed process, and catastrophic for the older installation's live
/// tunnel if both carried the same name. So the address is the one part of a
/// setup that cannot be inherited, and the one part replaced here. Both
/// generations then run side by side, each on a URL of its own.
///
/// That makes the rewrite load-bearing rather than cosmetic, so it fails
/// closed: a profile that was copied but could not be moved onto a new address
/// has its settings removed again, and this generation starts as a fresh
/// install. Losing a setup is a nuisance; taking down a tunnel that is serving
/// is not.
fn carry_profile(from: &Path, to: &Path) -> bool {
    if fs::create_dir_all(to).is_err() {
        return false;
    }
    for entry in CARRIED_PROFILE_ENTRIES {
        copy_entry(&from.join(entry), &to.join(entry));
    }
    if claim_separate_public_endpoint(to) {
        return true;
    }
    let _ = fs::remove_file(to.join("settings.json"));
    false
}

/// Put this profile on a public address no other installation is using.
fn claim_separate_public_endpoint(config_dir: &Path) -> bool {
    let paths = paths_in(config_dir.to_path_buf());
    let Ok(Some(mut settings)) = load_settings(&paths) else {
        return false;
    };
    settings.zrok_name = fresh_zrok_name();
    settings.public_path_token = fresh_public_path_token();
    save_settings(&paths, &settings).is_ok()
}

/// Copy one profile entry, file or directory, skipping what cannot be read.
/// A partial copy still saves most of a setup; a failed one is a first run.
fn copy_entry(source: &Path, target: &Path) {
    let Ok(kind) = fs::metadata(source).map(|data| data.file_type()) else {
        return;
    };
    if kind.is_file() {
        let _ = fs::copy(source, target);
        return;
    }
    if !kind.is_dir() || fs::create_dir_all(target).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        // The agent socket is a live endpoint, not state worth copying.
        if name == "agent.socket" {
            continue;
        }
        copy_entry(&entry.path(), &target.join(&name));
    }
}

/// `SECRET_TUNNEL_CONFIG_DIR` selects the exact configuration directory used for
/// settings, the managed MCP configuration, and diagnostics. When set it is used
/// verbatim: no organization/application suffix is appended, and an invalid or
/// unwritable override fails hard rather than falling back to the production
/// profile. This is the isolation mechanism used by the live smoke harness.
fn config_dir_override() -> Result<Option<PathBuf>, AppError> {
    let Some(value) = env::var_os("SECRET_TUNNEL_CONFIG_DIR") else {
        return Ok(None);
    };
    let trimmed = value.to_string_lossy().trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "invalid_config_dir",
            "SECRET_TUNNEL_CONFIG_DIR must not be empty.",
        ));
    }
    let path = PathBuf::from(&trimmed);
    if !path.is_absolute() {
        return Err(AppError::new(
            "invalid_config_dir",
            "SECRET_TUNNEL_CONFIG_DIR must be an absolute path.",
        ));
    }
    Ok(Some(path))
}

/// Read settings without persisting anything. This is the observation path:
/// status polling must never rewrite the settings file.
pub fn load_settings(paths: &AppPaths) -> Result<Option<Settings>, AppError> {
    Ok(load_settings_detailed(paths)?.map(|(settings, _)| settings))
}

/// Read settings, reporting whether the on-disk text had to be repaired to
/// parse. The bool is `true` when the stored file was not itself valid JSON.
/// Callers on a write-capable path use it to rewrite the file in canonical
/// form; the observation path ignores it and never writes.
pub fn load_settings_detailed(paths: &AppPaths) -> Result<Option<(Settings, bool)>, AppError> {
    if !paths.settings_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&paths.settings_path)?;
    let (settings, repaired) = parse_settings_text(&raw, &paths.settings_path)?;
    Ok(Some((settings, repaired)))
}

/// Parse a settings document that may have been edited by hand.
///
/// Two corruptions are recoverable without guessing at the user's intent, and
/// both are what a Windows text editor produces:
///
/// * a UTF-8 BOM in front of the opening brace, which `serde_json` rejects;
/// * Windows paths pasted verbatim, where each separator is a single backslash
///   rather than the doubled backslash JSON requires, so `\U` is read as an
///   invalid escape sequence and the whole document fails to parse.
///
/// Repair is only attempted after a normal parse has already failed, so a file
/// that is valid JSON is never reinterpreted. Recovering rather than falling
/// back to defaults is what preserves the stable public URL: the zrok name and
/// path token live in this file, and regenerating them would silently change
/// the address the user has already shared.
fn parse_settings_text(raw: &str, path: &Path) -> Result<(Settings, bool), AppError> {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if let Ok(settings) = serde_json::from_str::<Settings>(trimmed) {
        // Stripping only a BOM still means the stored bytes were not valid JSON.
        return Ok((settings, !std::ptr::eq(trimmed, raw)));
    }

    let repaired = escape_lone_backslashes(trimmed);
    match serde_json::from_str::<Settings>(&repaired) {
        Ok(settings) => Ok((settings, true)),
        Err(error) => Err(AppError::new(
            "settings_unreadable",
            format!(
                "The settings file at {} is not valid JSON and could not be repaired ({}). \
                 Fix or remove the file; it holds the stable public URL, so it is not \
                 replaced automatically.",
                path.display(),
                error
            ),
        )),
    }
}

/// Within JSON string literals, double any backslash that does not begin a
/// valid escape sequence. Text outside string literals is left untouched.
fn escape_lone_backslashes(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                in_string = !in_string;
                out.push(ch);
            }
            '\\' if in_string => match chars.peek().copied() {
                // A valid escape: copy it through verbatim.
                Some(next)
                    if matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') =>
                {
                    out.push(ch);
                    out.push(next);
                    chars.next();
                }
                // A lone separator backslash from a pasted Windows path: double it.
                _ => out.push_str("\\\\"),
            },
            _ => out.push(ch),
        }
    }
    out
}

/// Load existing settings, or create defaults on a genuine first run.
/// Reads are observation-only; normalization is applied in memory only.
/// A missing or temporarily unavailable workspace is preserved rather than
/// replaced with `None`: it remains stored so the user does not lose their
/// selection, but startup is blocked until the workspace is reachable again.
pub fn load_or_create_settings(paths: &AppPaths) -> Result<Settings, AppError> {
    if let Some((raw, repaired)) = load_settings_detailed(paths)? {
        let settings = raw.normalize();
        if repaired {
            // The stored file was not valid JSON but its contents were
            // recovered intact. Rewrite it in canonical form here, on the
            // write-capable path, so the repair happens once instead of on
            // every read. The recovered identity is preserved, so the public
            // URL does not change.
            save_settings(paths, &settings)?;
        }
        return Ok(settings);
    }

    let settings = Settings::default();
    save_settings(paths, &settings)?;
    Ok(settings)
}

/// Return the effective workspace path by validating the stored selection.
/// This does not modify settings. It returns `Ok(None)` when no workspace
/// is configured, `Ok(Some(path))` when the workspace is available and safe,
/// and `Err` with a specific code when the stored selection is blocked.
pub fn effective_workspace_path(
    workspace_path: &Option<String>,
) -> Result<Option<String>, AppError> {
    let Some(path) = workspace_path.as_deref() else {
        return Ok(None);
    };
    validate_workspace_path(path).map(Some)
}

pub fn save_settings(paths: &AppPaths, settings: &Settings) -> Result<(), AppError> {
    if let Some(parent) = paths.settings_path.parent() {
        fs::create_dir_all(parent).map_err(|_| {
            AppError::new(
                "settings_write_failed",
                "Could not create the settings directory.",
            )
        })?;
    }
    let tmp = paths.settings_path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    if let Err(error) = fs::write(&tmp, serde_json::to_vec_pretty(settings)?) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::new("settings_write_failed", error.to_string()));
    }
    if let Err(error) = fs::rename(&tmp, &paths.settings_path) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::new("settings_write_failed", error.to_string()));
    }
    Ok(())
}

/// Compute settings with any in-memory launch overrides applied. Does NOT
/// persist the result: the override values live only for this process's
/// lifetime. This allows the smoke harness to inject a test workspace, zrok
/// name, and path token without touching the production settings file.
pub fn apply_launch_environment_overrides(paths: &AppPaths) -> Result<Option<Settings>, AppError> {
    // Purely in-memory: load existing settings without creating a file, and use
    // defaults only as a base for the override merge. Nothing is persisted here.
    let mut settings = load_settings(paths)?.unwrap_or_default();
    let mut changed = false;

    if let Some(path) = launch_env("SECRET_TUNNEL_WORKSPACE_PATH") {
        settings.workspace_path = Some(validate_workspace_path(&path)?);
        changed = true;
    }
    if let Some(mode) = launch_env("SECRET_TUNNEL_ACCESS_MODE") {
        settings.access_mode = AccessMode::parse(&mode)?;
        changed = true;
    }
    if let Some(name) = launch_env("SECRET_TUNNEL_ZROK_NAME") {
        settings.zrok_name = validate_zrok_name(&name)?;
        changed = true;
    }
    if let Some(token) = launch_env("SECRET_TUNNEL_PUBLIC_PATH_TOKEN") {
        settings.public_path_token = validate_public_path_token(&token)?;
        changed = true;
    }

    Ok(changed.then_some(settings))
}

/// Deterministic, process-independent revision for a settings snapshot. Two
/// snapshots with identical configuration yield the same revision, so the
/// lifecycle coordinator can coalesce equivalent starts.
pub fn settings_revision(settings: &Settings) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    settings.workspace_path.hash(&mut hasher);
    settings.access_mode.as_str().hash(&mut hasher);
    settings.zrok_name.hash(&mut hasher);
    settings.public_path_token.hash(&mut hasher);
    settings.gpt_repo_mcp_path.hash(&mut hasher);
    // Binding-relevant state participates in the revision. A plan, approval or
    // broker session created under one binding must not still look current
    // after the feature is toggled or the repository binding changes, and the
    // revision is what the coordinator compares to decide that.
    // A scope change must invalidate every session started under the previous
    // one, so it participates in the revision exactly as a binding change does.
    if let Some(scope) = &settings.smart_scope {
        scope.name.hash(&mut hasher);
        for entry in &scope.matches {
            entry.project.hash(&mut hasher);
            entry.folder.hash(&mut hasher);
        }
    } else {
        "no-smart-scope".hash(&mut hasher);
    }
    settings.github.enabled.hash(&mut hasher);
    if let Some(binding) = &settings.github.binding {
        binding.workspace_fingerprint.hash(&mut hasher);
        binding.host.hash(&mut hasher);
        binding.owner.hash(&mut hasher);
        binding.repo.hash(&mut hasher);
        binding.repository_id.hash(&mut hasher);
        binding.integration_branch.hash(&mut hasher);
    }
    hasher.finish()
}

pub fn validate_zrok_name(value: &str) -> Result<String, AppError> {
    let normalized = value.trim().to_ascii_lowercase();
    if !(4..=32).contains(&normalized.len()) {
        return Err(AppError::new(
            "invalid_zrok_name",
            "Use 4 to 32 lowercase letters, numbers, or hyphens.",
        ));
    }
    if normalized.starts_with('-') || normalized.ends_with('-') {
        return Err(AppError::new(
            "invalid_zrok_name",
            "The zrok name cannot start or end with a hyphen.",
        ));
    }
    if !normalized
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(AppError::new(
            "invalid_zrok_name",
            "Use only lowercase letters, numbers, and hyphens.",
        ));
    }
    Ok(normalized)
}

pub fn validate_public_path_token(value: &str) -> Result<String, AppError> {
    let token = value.trim();
    if !(8..=64).contains(&token.len()) {
        return Err(AppError::new(
            "invalid_public_path_token",
            "Use 8 to 64 letters, numbers, hyphens, or underscores.",
        ));
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(AppError::new(
            "invalid_public_path_token",
            "Use only letters, numbers, hyphens, or underscores.",
        ));
    }
    Ok(token.to_string())
}

/// A client id is pasted by hand and then sent to GitHub in a form body, so
/// accept only the shapes GitHub itself issues and nothing that could carry a
/// second field into the request.
pub fn validate_github_client_id(value: &str) -> Result<String, AppError> {
    let id = value.trim();
    let invalid = || {
        AppError::new(
            "invalid_github_client_id",
            "Paste the Client ID from the GitHub app page, such as Ov23liAbCdEf0123456.",
        )
    };
    if !(8..=64).contains(&id.len()) {
        return Err(invalid());
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-')
    {
        return Err(invalid());
    }
    Ok(id.to_string())
}

pub fn validate_workspace_path(path: &str) -> Result<String, AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("missing_folder", "Select a folder first."));
    }
    let raw = PathBuf::from(trimmed);
    if !raw.is_absolute() {
        return Err(AppError::new(
            "invalid_folder",
            "Use an absolute folder path.",
        ));
    }
    let canonical = fs::canonicalize(&raw).map_err(|_| {
        AppError::new(
            "folder_unavailable",
            "That folder does not exist or cannot be read.",
        )
    })?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "invalid_folder",
            "The selected path is not a folder.",
        ));
    }
    if is_filesystem_root(&canonical) {
        return Err(AppError::new(
            "unsafe_folder",
            "Do not expose a drive root or filesystem root.",
        ));
    }
    if is_home_directory(&canonical) || is_system_directory(&canonical) {
        return Err(AppError::new(
            "unsafe_folder",
            "Pick a project folder, not a home, system, or application folder.",
        ));
    }
    Ok(normalize_windows_verbatim_prefix(
        &canonical.to_string_lossy(),
    ))
}

/// A stable id for a folder, derived from its canonical path.
///
/// Positional ids would move when a folder is removed from the middle of the
/// list, so a request naming one folder would land on another. The path is what
/// the id has to follow.
fn folder_repo_id(root: &str) -> String {
    path_repo_id("folder", root)
}

/// The same derivation for an approved Smart folders subfolder, under a prefix
/// of its own. A smart root is never given the `workspace` id or a `folder-`
/// id: those name whole projects, and a saved plan or receipt that still refers
/// to one must fail to resolve rather than quietly land inside a subfolder.
fn smart_repo_id(root: &str) -> String {
    path_repo_id("smart", root)
}

fn path_repo_id(prefix: &str, root: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    format!("{prefix}-{:x}", hasher.finish())
}

/// The grouping key for a directory name: case-insensitive and complete.
///
/// Rust's `to_lowercase` is Unicode and takes no locale, so the same name maps
/// to the same key on every machine. Nothing else is folded - hyphens are not
/// spaces, and `For-AI-backup` is a different name from `For-AI`.
pub fn fold_folder_name(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The canonical roots of every project registered in the Folders list, primary
/// first, re-validated now rather than trusted from the file.
pub fn registered_projects(settings: &Settings) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for candidate in settings
        .workspace_path
        .iter()
        .chain(settings.extra_folders.iter())
    {
        let Ok(root) = validate_workspace_path(candidate) else {
            continue;
        };
        if !roots.iter().any(|existing| paths_equal(existing, &root)) {
            roots.push(root);
        }
    }
    roots
}

/// The roots this endpoint actually serves - the one resolver every caller
/// shares, so the MCP config, the Storage Box's local roots and the window all
/// answer with the same set instead of three near-copies that can disagree.
///
/// Without a smart scope this is the folder list as it has always been. With
/// one it is *only* the approved subfolders: the projects themselves are not
/// among them, so nothing outside an approved subfolder is reachable at all.
pub fn effective_roots(settings: &Settings) -> Result<Vec<EffectiveRoot>, AppError> {
    let root = settings
        .workspace_path
        .as_deref()
        .ok_or_else(|| AppError::new("missing_folder", "Select a folder first."))
        .and_then(validate_workspace_path)?;

    if let Some(scope) = &settings.smart_scope {
        return smart_roots(&registered_projects(settings), scope);
    }

    // The primary folder keeps the "workspace" id it has always had: the GitHub
    // binding, the actions framework and any saved plan refer to it by that
    // name, and renaming it here would orphan all of them.
    let mut roots = vec![EffectiveRoot {
        repo_id: "workspace".to_string(),
        display_name: folder_display_name(&root).to_string(),
        root: root.clone(),
    }];
    for extra in &settings.extra_folders {
        // Re-validated on every write, not just when it was added: a folder can
        // be deleted, moved, or replaced by a link between one run and the next.
        let Ok(extra_root) = validate_workspace_path(extra) else {
            continue;
        };
        if roots
            .iter()
            .any(|entry| paths_equal(&entry.root, &extra_root))
        {
            continue;
        }
        roots.push(EffectiveRoot {
            repo_id: folder_repo_id(&extra_root),
            display_name: folder_display_name(&extra_root).to_string(),
            root: extra_root,
        });
    }
    Ok(roots)
}

/// Turn the stored approvals into roots, re-proving every one of them.
///
/// Stored paths are a record of what the person approved, not authority in
/// themselves. Each match has to still be an immediate child of a *currently
/// registered* project, still carry the scope's name, and still be a real
/// directory rather than a link - so removing a project revokes its matches,
/// and a folder replaced by a junction stops being a root.
///
/// No surviving match is an error, not an empty allow list: the services refuse
/// to start rather than falling back to the projects themselves.
fn smart_roots(projects: &[String], scope: &SmartScope) -> Result<Vec<EffectiveRoot>, AppError> {
    let key = fold_folder_name(&scope.name);
    if key.is_empty() {
        return Err(smart_scope_unavailable());
    }
    let mut roots: Vec<EffectiveRoot> = Vec::new();
    for entry in &scope.matches {
        let Some(project) = projects
            .iter()
            .find(|project| paths_equal(project, &entry.project))
        else {
            continue;
        };
        let Ok(folder) = approved_child(project, &entry.folder, &key) else {
            continue;
        };
        if roots.iter().any(|root| paths_equal(&root.root, &folder)) {
            continue;
        }
        roots.push(EffectiveRoot {
            repo_id: smart_repo_id(&folder),
            display_name: format!(
                "{}/{}",
                folder_display_name(project),
                folder_display_name(&folder)
            ),
            root: folder,
        });
    }
    if roots.is_empty() {
        return Err(smart_scope_unavailable());
    }
    Ok(roots)
}

pub fn smart_scope_unavailable() -> AppError {
    AppError::new(
        "smart_scope_unavailable",
        "No approved Smart folder is available. Open Folders to apply a scope again, or restore full-project access.",
    )
}

/// Re-prove one approved subfolder against the project it belongs to.
///
/// The lexical join is compared with the canonical path on purpose. A junction
/// or symlink canonicalizes somewhere else, so the two disagree and the match
/// is rejected - which is the check `symlink_metadata` alone does not reliably
/// make on Windows, where a junction and a directory look much alike.
pub fn approved_child(project: &str, folder: &str, key: &str) -> Result<String, AppError> {
    let rejected = || {
        AppError::new(
            "smart_folder_rejected",
            "That folder is not an approved match inside a registered project.",
        )
    };
    let name = Path::new(folder)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(rejected)?;
    if fold_folder_name(name) != key {
        return Err(rejected());
    }
    let lexical = Path::new(project).join(name);
    let canonical = fs::canonicalize(&lexical).map_err(|_| rejected())?;
    let canonical = normalize_windows_verbatim_prefix(&canonical.to_string_lossy());
    if !paths_equal(&canonical, &lexical.to_string_lossy()) {
        return Err(rejected());
    }
    if !Path::new(&canonical).is_dir() {
        return Err(rejected());
    }
    Ok(canonical)
}

/// Two stored paths naming the same directory. Windows compares case-blind and
/// POSIX does not, which is what `same_path` already encodes.
pub fn paths_equal(left: &str, right: &str) -> bool {
    same_path(Path::new(left), Path::new(right))
}

/// One entry in the MCP config's `repos` array. The deny list is the reason
/// this is a function: every folder gets exactly the same protections, and a
/// second copy of that list would be one edit away from disagreeing with the
/// first.
fn repo_entry(repo_id: &str, display_name: &str, root: &str, writes_enabled: bool) -> Value {
    json!({
        "repo_id": repo_id,
        "display_name": display_name,
        "root": root,
        "allow_non_git": true,
        "writes": {
            "enabled": writes_enabled,
            "allowed_globs": ["**"],
            "denied_globs": [
                ".git/**", ".env", ".env.*", "**/*.pem", "**/*.key",
                ".chatgpt/actions/reports/**", ".chatgpt/actions/workspace.json",
                ".chatgpt/actions/template.json", ".chatgpt/actions/README.md",
                ".chatgpt/actions/controller.lock",
                ".[cC][hH][aA][tT][gG][pP][tT]/[aA][cC][tT][iI][oO][nN][sS]/[rR][eE][pP][oO][rR][tT][sS]/**",
                ".[cC][hH][aA][tT][gG][pP][tT]/[aA][cC][tT][iI][oO][nN][sS]/[wW][oO][rR][kK][sS][pP][aA][cC][eE].[jJ][sS][oO][nN]",
                ".[cC][hH][aA][tT][gG][pP][tT]/[aA][cC][tT][iI][oO][nN][sS]/[tT][eE][mM][pP][lL][aA][tT][eE].[jJ][sS][oO][nN]",
                ".[cC][hH][aA][tT][gG][pP][tT]/[aA][cC][tT][iI][oO][nN][sS]/[rR][eE][aA][dD][mM][eE].[mM][dD]",
                ".[cC][hH][aA][tT][gG][pP][tT]/[aA][cC][tT][iI][oO][nN][sS]/[cC][oO][nN][tT][rR][oO][lL][lL][eE][rR].[lL][oO][cC][kK]"
            ],
            "max_bytes_per_write": 1048576
        },
        "operations": {
            "enabled": false
        }
    })
}

/// The display name a folder is listed under: its own directory name.
fn folder_display_name(root: &str) -> &str {
    Path::new(root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Selected folder")
}

pub fn write_managed_mcp_config(paths: &AppPaths, settings: &Settings) -> Result<(), AppError> {
    let writes_enabled = settings.access_mode == AccessMode::ReadWrite;
    let repos: Vec<Value> = effective_roots(settings)?
        .iter()
        .map(|entry| {
            repo_entry(
                &entry.repo_id,
                &entry.display_name,
                &entry.root,
                writes_enabled,
            )
        })
        .collect();

    let document = json!({
        "repos": repos,
        "limits": {
            "max_files": 50,
            "max_bytes_per_file": 128000,
            "max_total_bytes": 750000
        }
    });

    if let Some(parent) = paths.managed_config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = paths.managed_config_path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&document)?)?;
    fs::rename(tmp, &paths.managed_config_path)?;
    Ok(())
}

pub fn mcp_url(settings: &Settings) -> String {
    format!(
        "https://{}.shares.zrok.io/t/{}/mcp",
        settings.zrok_name, settings.public_path_token
    )
}

/// Replace credential-bearing strings with a redacted marker so that
/// diagnostic output and logs do not leak secrets.
pub fn redact_secrets(input: &str, secrets: &[String]) -> String {
    let mut out = input.to_string();
    for secret in secrets {
        if !secret.is_empty() && secret.len() >= 4 {
            out = out.replace(secret, "[redacted]");
        }
    }
    out
}

/// Collect secrets that should be redacted from diagnostic output.
pub fn secrets_for_redaction(settings: &Settings) -> Vec<String> {
    let mut secrets = Vec::new();
    if !settings.public_path_token.is_empty() {
        secrets.push(settings.public_path_token.clone());
    }
    // Also redact the enable token if present in the process environment,
    // which is transient but still a credential.
    if let Some(token) = env::var_os("SECRET_TUNNEL_ZROK_ENABLE_TOKEN") {
        let t = token.to_string_lossy().trim().to_string();
        if t.len() >= 8 {
            secrets.push(t);
        }
    }
    secrets
}

fn launch_env(variable: &str) -> Option<String> {
    env::var_os(variable)
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn is_home_directory(path: &Path) -> bool {
    ["USERPROFILE", "HOME"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .filter_map(|home| fs::canonicalize(home).ok())
        .any(|home| same_path(&home, path))
}

fn is_system_directory(path: &Path) -> bool {
    system_directory_candidates()
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .any(|candidate| same_path(&candidate, path))
}

fn system_directory_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for variable in [
        "WINDIR",
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Some(value) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(value));
        }
    }
    if cfg!(windows) {
        candidates.extend([
            PathBuf::from(r"C:\Windows"),
            PathBuf::from(r"C:\Program Files"),
        ]);
    } else {
        candidates.extend([
            PathBuf::from("/bin"),
            PathBuf::from("/etc"),
            PathBuf::from("/usr"),
        ]);
    }
    candidates
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        normalize_windows_verbatim_prefix(&left.to_string_lossy())
            .eq_ignore_ascii_case(&normalize_windows_verbatim_prefix(&right.to_string_lossy()))
    } else {
        left == right
    }
}

fn default_github_host() -> String {
    "github.com".to_string()
}

fn default_integration_branch() -> String {
    "main".to_string()
}

fn default_version() -> u32 {
    1
}

fn default_access_mode() -> AccessMode {
    AccessMode::Read
}

fn default_public_path_token() -> String {
    Uuid::new_v4().simple().to_string()
}

fn default_zrok_name() -> String {
    let token = default_public_path_token();
    format!("gptmcp{}", &token[..12])
}

pub fn fresh_public_path_token() -> String {
    default_public_path_token()
}

pub fn fresh_zrok_name() -> String {
    let token = fresh_public_path_token();
    format!("gptmcp{}", &token[..12])
}

fn default_gpt_repo_mcp_path() -> String {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    home.map(PathBuf::from)
        .map(|path| {
            path.join("Documents")
                .join("GitHub")
                .join("gpt-repo-mcp")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_else(|| "gpt-repo-mcp".to_string())
}

pub fn normalize_windows_verbatim_prefix(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{stripped}")
    } else if let Some(stripped) = path.strip_prefix("\\\\?\\") {
        stripped.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_launch_environment_overrides, carry_profile, effective_workspace_path,
        fresh_public_path_token, fresh_zrok_name, is_home_directory, load_or_create_settings,
        load_settings, load_settings_detailed, normalize_windows_verbatim_prefix, redact_secrets,
        save_settings, seed_from_previous_generation, settings_revision,
        validate_public_path_token, validate_zrok_name, write_managed_mcp_config, AccessMode,
        AppPaths, ApprovalMode, GitHubSettings, RepositoryBinding, Settings,
    };
    use std::sync::Mutex;
    use std::{env, fs};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Per-test directory. Tests run in parallel, so each one needs its own
    /// config dir; sharing a single path makes cleanup in one test delete the
    /// fixtures of another.
    fn named_test_paths(name: &str) -> AppPaths {
        let root = env::temp_dir().join(format!(
            "secret-tunnel-settings-test-{}-{}",
            std::process::id(),
            name
        ));
        AppPaths {
            config_dir: root.clone(),
            settings_path: root.join("settings.json"),
            managed_config_path: root.join("gpt-repo-mcp.config.json"),
            diagnostics_path: root.join("diagnostics.log"),
        }
    }

    #[test]
    fn validates_zrok_names() {
        assert_eq!(validate_zrok_name("My-Mcp1").unwrap(), "my-mcp1");
        assert!(validate_zrok_name("abc").is_err());
        assert!(validate_zrok_name("-abcd").is_err());
        assert!(validate_zrok_name("abc_def").is_err());
    }

    #[test]
    fn validates_public_path_tokens() {
        assert_eq!(
            validate_public_path_token(" token_123-abc ").unwrap(),
            "token_123-abc"
        );
        assert!(validate_public_path_token("short").is_err());
        assert!(validate_public_path_token("has space").is_err());
        assert!(validate_public_path_token("has/slash").is_err());
    }

    #[test]
    fn generates_fresh_zrok_identity() {
        let name = fresh_zrok_name();
        let token = fresh_public_path_token();
        assert_eq!(validate_zrok_name(&name).unwrap(), name);
        assert_eq!(validate_public_path_token(&token).unwrap(), token);
        assert_ne!(fresh_zrok_name(), name);
        assert_ne!(fresh_public_path_token(), token);
        assert!(name.starts_with("gptmcp"));
    }

    #[test]
    fn parses_access_modes() {
        assert_eq!(AccessMode::parse("read").unwrap(), AccessMode::Read);
        assert_eq!(
            AccessMode::parse("read_write").unwrap(),
            AccessMode::ReadWrite
        );
        assert!(AccessMode::parse("ship").is_err());
    }

    #[test]
    fn normalizes_windows_verbatim_prefixes() {
        assert_eq!(
            normalize_windows_verbatim_prefix(r"\\?\C:\Users\George\Project"),
            r"C:\Users\George\Project"
        );
        assert_eq!(
            normalize_windows_verbatim_prefix(r"\\?\UNC\server\share\Project"),
            r"\\server\share\Project"
        );
        assert_eq!(
            normalize_windows_verbatim_prefix(r"C:\Users\George\Project"),
            r"C:\Users\George\Project"
        );
    }

    #[test]
    fn detects_configured_home_directory() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = env::temp_dir().join(format!("secret-tunnel-home-test-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let previous = env::var_os("USERPROFILE");
        env::set_var("USERPROFILE", &home);
        assert!(is_home_directory(&fs::canonicalize(&home).unwrap()));
        if let Some(previous) = previous {
            env::set_var("USERPROFILE", previous);
        } else {
            env::remove_var("USERPROFILE");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn preserves_unsafe_workspace_in_stored_settings() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = env::temp_dir().join(format!(
            "secret-tunnel-settings-test-{}",
            std::process::id()
        ));
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let paths = AppPaths {
            config_dir: root.clone(),
            settings_path: root.join("settings.json"),
            managed_config_path: root.join("gpt-repo-mcp.config.json"),
            diagnostics_path: root.join("diagnostics.log"),
        };
        let previous = env::var_os("USERPROFILE");
        env::set_var("USERPROFILE", &home);
        let settings = Settings {
            workspace_path: Some(home.to_string_lossy().to_string()),
            ..Settings::default()
        };
        save_settings(&paths, &settings).unwrap();

        // load_or_create_settings must preserve the stored path (observation-only)
        let loaded = load_or_create_settings(&paths).unwrap();
        assert_eq!(
            loaded.workspace_path,
            Some(home.to_string_lossy().to_string())
        );

        // effective_workspace_path blocks the unsafe selection without erasing it
        let effective = effective_workspace_path(&loaded.workspace_path);
        assert!(effective.is_err());
        let err = effective.unwrap_err();
        assert_eq!(err.code, "unsafe_folder");

        // The on-disk file is unchanged
        let reloaded = load_settings(&paths).unwrap().unwrap();
        assert_eq!(
            reloaded.workspace_path,
            Some(home.to_string_lossy().to_string())
        );

        if let Some(previous) = previous {
            env::set_var("USERPROFILE", previous);
        } else {
            env::remove_var("USERPROFILE");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_unavailable_workspace_in_stored_settings() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = env::temp_dir().join(format!(
            "secret-tunnel-unavailable-test-{}",
            std::process::id()
        ));
        let paths = AppPaths {
            config_dir: root.clone(),
            settings_path: root.join("settings.json"),
            managed_config_path: root.join("gpt-repo-mcp.config.json"),
            diagnostics_path: root.join("diagnostics.log"),
        };
        // Must be absolute for the platform under test: a Windows-style path is
        // merely *relative* on Unix, so validation would reject it as
        // invalid_folder long before it could report folder_unavailable.
        let missing = if cfg!(windows) {
            r"C:\nonexistent\fake\folder"
        } else {
            "/nonexistent/fake/folder"
        };
        let settings = Settings {
            workspace_path: Some(missing.to_string()),
            ..Settings::default()
        };
        save_settings(&paths, &settings).unwrap();

        // load_or_create_settings must preserve the stored path (observation-only)
        let loaded = load_or_create_settings(&paths).unwrap();
        assert_eq!(loaded.workspace_path, Some(missing.to_string()));

        // effective_workspace_path reports the folder as unavailable
        let effective = effective_workspace_path(&loaded.workspace_path);
        assert!(effective.is_err());
        let err = effective.unwrap_err();
        assert_eq!(err.code, "folder_unavailable");

        // The on-disk file is unchanged
        let reloaded = load_settings(&paths).unwrap().unwrap();
        assert_eq!(reloaded.workspace_path, Some(missing.to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn applies_launch_environment_overrides_in_memory_only() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = env::temp_dir().join(format!(
            "secret-tunnel-launch-env-test-{}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let paths = AppPaths {
            config_dir: root.clone(),
            settings_path: root.join("settings.json"),
            managed_config_path: root.join("gpt-repo-mcp.config.json"),
            diagnostics_path: root.join("diagnostics.log"),
        };

        let previous_workspace = env::var_os("SECRET_TUNNEL_WORKSPACE_PATH");
        let previous_mode = env::var_os("SECRET_TUNNEL_ACCESS_MODE");
        let previous_name = env::var_os("SECRET_TUNNEL_ZROK_NAME");
        let previous_token = env::var_os("SECRET_TUNNEL_PUBLIC_PATH_TOKEN");

        env::set_var("SECRET_TUNNEL_WORKSPACE_PATH", &workspace);
        env::set_var("SECRET_TUNNEL_ACCESS_MODE", "read_write");
        env::set_var("SECRET_TUNNEL_ZROK_NAME", "Launch-MCP-1");
        env::set_var("SECRET_TUNNEL_PUBLIC_PATH_TOKEN", "token_123456");

        let result = apply_launch_environment_overrides(&paths).unwrap();
        assert!(result.is_some());
        let overridden = result.unwrap();
        assert_eq!(overridden.access_mode, AccessMode::ReadWrite);
        assert_eq!(overridden.zrok_name, "launch-mcp-1");
        assert_eq!(overridden.public_path_token, "token_123456");
        assert_eq!(
            overridden.workspace_path,
            Some(normalize_windows_verbatim_prefix(
                &fs::canonicalize(&workspace).unwrap().to_string_lossy()
            ))
        );

        // The settings file was NOT modified by the in-memory override
        let persisted = load_settings(&paths).unwrap();
        assert!(
            persisted.is_none(),
            "no settings file should have been created"
        );

        restore_env("SECRET_TUNNEL_WORKSPACE_PATH", previous_workspace);
        restore_env("SECRET_TUNNEL_ACCESS_MODE", previous_mode);
        restore_env("SECRET_TUNNEL_ZROK_NAME", previous_name);
        restore_env("SECRET_TUNNEL_PUBLIC_PATH_TOKEN", previous_token);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redacts_credentials_from_output() {
        let token = "abcdef1234567890";
        let url = format!("https://foo.shares.zrok.io/t/{token}/mcp");
        let secrets = vec![token.to_string()];
        let redacted = redact_secrets(&url, &secrets);
        assert!(!redacted.contains(token));
        assert!(redacted.contains("[redacted]"));
    }

    fn restore_env(variable: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            env::set_var(variable, value);
        } else {
            env::remove_var(variable);
        }
    }

    /// A settings file saved by a Windows text editor keeps its identity: the
    /// BOM and the single-backslash paths are repaired rather than discarded,
    /// because discarding them would rotate the public URL.
    #[test]
    fn recovers_hand_edited_settings_without_changing_identity() {
        let paths = named_test_paths("hand-edited");
        fs::create_dir_all(&paths.config_dir).unwrap();
        // A UTF-8 BOM plus Windows paths written with single backslashes:
        // exactly what a hand-edited settings file looks like, and not
        // parseable as JSON.
        let hand_edited = format!(
            "\u{feff}{}",
            r#"{
  "version": 1,
  "workspacePath": "C:\Users\Me\Documents",
  "accessMode": "read_write",
  "zrokName": "gptmcpexamplename1",
  "publicPathToken": "0123456789abcdef0123456789abcdef",
  "gptRepoMcpPath": "C:\Users\Me\gpt-repo-mcp"
}"#
        );
        assert!(
            serde_json::from_str::<Settings>(&hand_edited).is_err(),
            "fixture must be invalid JSON or the test proves nothing"
        );
        fs::write(&paths.settings_path, &hand_edited).unwrap();

        let (settings, repaired) = load_settings_detailed(&paths).unwrap().unwrap();
        assert!(repaired, "the stored bytes were not valid JSON");
        assert_eq!(settings.zrok_name, "gptmcpexamplename1");
        assert_eq!(
            settings.public_path_token,
            "0123456789abcdef0123456789abcdef"
        );
        assert_eq!(
            settings.workspace_path.as_deref(),
            Some(r"C:\Users\Me\Documents")
        );
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// Repairing must be a one-time migration, not something every read redoes.
    #[test]
    fn repaired_settings_are_rewritten_as_valid_json() {
        let paths = named_test_paths("rewritten");
        fs::create_dir_all(&paths.config_dir).unwrap();
        let hand_edited = format!(
            "\u{feff}{}",
            r#"{"version":1,"zrokName":"gptmcpstable0001","publicPathToken":"0123456789abcdef0123456789abcdef","workspacePath":"C:\Users\Me"}"#
        );
        fs::write(&paths.settings_path, &hand_edited).unwrap();

        let before = load_or_create_settings(&paths).unwrap();
        let on_disk = fs::read_to_string(&paths.settings_path).unwrap();
        assert!(!on_disk.starts_with('\u{feff}'), "BOM should be gone");
        serde_json::from_str::<Settings>(&on_disk).expect("rewritten file must be valid JSON");

        let (after, repaired) = load_settings_detailed(&paths).unwrap().unwrap();
        assert!(!repaired, "a second read must not need repair");
        assert_eq!(before.zrok_name, after.zrok_name);
        assert_eq!(before.public_path_token, after.public_path_token);
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// Valid JSON must never be reinterpreted by the repair path.
    #[test]
    fn valid_settings_are_not_repaired() {
        let paths = named_test_paths("valid");
        fs::create_dir_all(&paths.config_dir).unwrap();
        let settings = Settings::default();
        save_settings(&paths, &settings).unwrap();
        let (_, repaired) = load_settings_detailed(&paths).unwrap().unwrap();
        assert!(!repaired);
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// Unrecoverable content must fail loudly and keep the file, because the
    /// file is the only copy of the stable public URL.
    #[test]
    fn unrecoverable_settings_report_an_error_instead_of_resetting() {
        let paths = named_test_paths("unrecoverable");
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(&paths.settings_path, "this is not json at all").unwrap();
        let error = load_settings_detailed(&paths).unwrap_err();
        assert_eq!(error.code, "settings_unreadable");
        assert!(fs::read_to_string(&paths.settings_path)
            .unwrap()
            .contains("not json"));
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    // ---------------------------------------------------------------------
    // T01 - GitHub settings and migration (For-AI/PLANNER/github-sync)
    // ---------------------------------------------------------------------

    /// T01.1 - a settings file written before the feature existed must load,
    /// with GitHub off. This is the whole promise made to existing installs.
    #[test]
    fn t01_settings_without_github_load_with_the_feature_disabled() {
        let paths = named_test_paths("t01-legacy");
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(
            &paths.settings_path,
            r#"{
  "version": 1,
  "workspacePath": "C:\\Users\\Me\\project",
  "accessMode": "read_write",
  "zrokName": "gptmcpexamplename1",
  "publicPathToken": "0123456789abcdef0123456789abcdef",
  "gptRepoMcpPath": "C:\\Users\\Me\\gpt-repo-mcp"
}"#,
        )
        .unwrap();

        let loaded = load_or_create_settings(&paths).unwrap();
        assert!(!loaded.github.enabled, "GitHub must default to off");
        assert!(loaded.github.binding.is_none());
        assert_eq!(loaded.github.approval_mode, ApprovalMode::Local);
        // Everything that existed before must survive untouched.
        assert_eq!(loaded.zrok_name, "gptmcpexamplename1");
        assert_eq!(loaded.access_mode, AccessMode::ReadWrite);
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// T01.2 - no credential material is serialised. The settings file lives in
    /// the profile directory as plain JSON and is read by status paths, so a
    /// token must never reach it even if one is held in memory elsewhere.
    #[test]
    fn t01_serialized_settings_contain_no_credential_fields() {
        let paths = named_test_paths("t01-nocreds");
        fs::create_dir_all(&paths.config_dir).unwrap();
        let mut settings = Settings::default();
        settings.github = GitHubSettings {
            enabled: true,
            binding: Some(RepositoryBinding {
                workspace_fingerprint: "fp-1".to_string(),
                host: "github.com".to_string(),
                owner: "octocat".to_string(),
                repo: "hello-world".to_string(),
                repository_id: Some(1296269),
                integration_branch: "main".to_string(),
                pages_url: Some("https://octocat.github.io/hello-world/".to_string()),
                pages_domain: None,
            }),
            approval_mode: ApprovalMode::Local,
        };
        save_settings(&paths, &settings).unwrap();

        let raw = fs::read_to_string(&paths.settings_path).unwrap();
        // Scope the assertion to the GitHub object: the surrounding document
        // legitimately contains publicPathToken, which is the tunnel's own
        // path secret and predates this feature.
        let document: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let github = document
            .get("github")
            .expect("github section")
            .to_string()
            .to_lowercase();
        for forbidden in [
            "token",
            "oauth",
            "password",
            "secret",
            "credential",
            "bearer",
            "ghp_",
            "gho_",
            "github_pat",
            "apikey",
            "api_key",
        ] {
            assert!(
                !github.contains(forbidden),
                "GitHub settings must not serialize {forbidden}: {github}"
            );
        }
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// T01.3 - a binding survives a restart while the folder is unchanged.
    #[test]
    fn t01_binding_survives_a_reload() {
        let paths = named_test_paths("t01-roundtrip");
        fs::create_dir_all(&paths.config_dir).unwrap();
        let mut settings = Settings::default();
        settings.github.enabled = true;
        settings.github.binding = Some(RepositoryBinding {
            workspace_fingerprint: "fp-stable".to_string(),
            host: "github.com".to_string(),
            owner: "octocat".to_string(),
            repo: "hello-world".to_string(),
            repository_id: Some(1296269),
            integration_branch: "release".to_string(),
            pages_url: None,
            pages_domain: None,
        });
        save_settings(&paths, &settings).unwrap();

        let reloaded = load_or_create_settings(&paths).unwrap();
        assert_eq!(reloaded.github, settings.github);
        assert!(reloaded.github.is_active_for("fp-stable"));
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// T01.4 - selecting a different folder must not inherit the binding. The
    /// fingerprint is compared rather than assumed, so the binding simply
    /// stops being active instead of pointing the wrong repository at the
    /// wrong files.
    #[test]
    fn t01_binding_is_inactive_for_a_different_workspace() {
        let mut github = GitHubSettings::default();
        github.enabled = true;
        github.binding = Some(RepositoryBinding {
            workspace_fingerprint: "fp-original".to_string(),
            host: "github.com".to_string(),
            owner: "octocat".to_string(),
            repo: "hello-world".to_string(),
            repository_id: None,
            integration_branch: "main".to_string(),
            pages_url: None,
            pages_domain: None,
        });

        assert!(github.is_active_for("fp-original"));
        assert!(!github.is_active_for("fp-different-folder"));
    }

    /// T01.4b - the feature being off is enough to make a binding inert, even
    /// for the folder it was made for.
    #[test]
    fn t01_disabled_feature_is_never_active() {
        let mut github = GitHubSettings::default();
        github.binding = Some(RepositoryBinding {
            workspace_fingerprint: "fp".to_string(),
            host: "github.com".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
            repository_id: None,
            integration_branch: "main".to_string(),
            pages_url: None,
            pages_domain: None,
        });
        assert!(!github.enabled);
        assert!(!github.is_active_for("fp"));
    }

    /// T01.6 - unknown fields must not fail the load or disturb the tunnel
    /// identity. A newer build writing extra keys must not brick an older one.
    #[test]
    fn t01_unknown_github_fields_are_ignored_safely() {
        let paths = named_test_paths("t01-unknown");
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(
            &paths.settings_path,
            r#"{
  "version": 1,
  "zrokName": "gptmcpexamplename1",
  "publicPathToken": "0123456789abcdef0123456789abcdef",
  "github": { "enabled": true, "somethingFromTheFuture": 42 }
}"#,
        )
        .unwrap();

        let loaded = load_or_create_settings(&paths).unwrap();
        assert!(loaded.github.enabled);
        assert_eq!(loaded.zrok_name, "gptmcpexamplename1");
        assert_eq!(loaded.public_path_token, "0123456789abcdef0123456789abcdef");
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// A profile written while the Client ID was a user setting must not send
    /// this build to somebody else's OAuth App. The key is simply ignored.
    #[test]
    fn a_legacy_stored_client_id_does_not_shadow_the_shipped_one() {
        let paths = named_test_paths("legacy-client-id");
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(
            &paths.settings_path,
            r#"{
  "version": 1,
  "zrokName": "gptmcpexamplename1",
  "publicPathToken": "0123456789abcdef0123456789abcdef",
  "github": { "enabled": true, "clientId": "Ov23liSomeoneElsesApp" }
}"#,
        )
        .unwrap();

        let loaded = load_or_create_settings(&paths).unwrap();
        assert!(loaded.github.enabled, "the rest of the profile still loads");
        // Nothing in the loaded settings can carry a client id any more, and
        // the resolver never consults the profile.
        let serialized = serde_json::to_string(&loaded.github).unwrap();
        assert!(!serialized.contains("Ov23liSomeoneElsesApp"));
        assert_eq!(
            crate::github::account::resolve_client_id().unwrap(),
            "Ov23liL29bL0ZqF73KPk"
        );
        fs::remove_dir_all(&paths.config_dir).ok();
    }

    /// T01.7 - the settings revision must change for every binding-relevant
    /// change, because that revision is what invalidates plans and approvals.
    /// If it did not move, a plan created for one repository would still look
    /// current after the binding was pointed at another.
    #[test]
    fn t01_revision_changes_for_binding_relevant_changes() {
        let base = Settings::default();
        let baseline = settings_revision(&base);

        let mut enabled = base.clone();
        enabled.github.enabled = true;
        assert_ne!(
            settings_revision(&enabled),
            baseline,
            "enabling must move it"
        );

        let binding = RepositoryBinding {
            workspace_fingerprint: "fp".to_string(),
            host: "github.com".to_string(),
            owner: "octocat".to_string(),
            repo: "hello-world".to_string(),
            repository_id: Some(1),
            integration_branch: "main".to_string(),
            pages_url: None,
            pages_domain: None,
        };

        let mut bound = enabled.clone();
        bound.github.binding = Some(binding.clone());
        let bound_revision = settings_revision(&bound);
        assert_ne!(bound_revision, settings_revision(&enabled));

        for mutate in [
            |b: &mut RepositoryBinding| b.owner = "someone-else".to_string(),
            |b: &mut RepositoryBinding| b.repo = "other-repo".to_string(),
            |b: &mut RepositoryBinding| b.repository_id = Some(2),
            |b: &mut RepositoryBinding| b.integration_branch = "release".to_string(),
            |b: &mut RepositoryBinding| b.workspace_fingerprint = "fp-2".to_string(),
            |b: &mut RepositoryBinding| b.host = "github.enterprise".to_string(),
        ] {
            let mut changed = bound.clone();
            let mut changed_binding = binding.clone();
            mutate(&mut changed_binding);
            changed.github.binding = Some(changed_binding);
            assert_ne!(
                settings_revision(&changed),
                bound_revision,
                "a binding change must change the settings revision"
            );
        }

        // A display-only cache must not, or the URL arriving would needlessly
        // invalidate work in progress.
        let mut cached = bound.clone();
        let mut cached_binding = binding;
        cached_binding.pages_url = Some("https://octocat.github.io/hello-world/".to_string());
        cached.github.binding = Some(cached_binding);
        assert_eq!(settings_revision(&cached), bound_revision);
    }

    /// Every listed folder becomes a root of its own, and each keeps an id the
    /// model can name. The primary keeps "workspace" because the GitHub binding
    /// and the actions framework already refer to it by that name.
    #[test]
    fn writes_one_repo_per_folder() {
        let root = env::temp_dir().join(format!("secret-tunnel-folders-{}", std::process::id()));
        let primary = root.join("primary");
        let second = root.join("second");
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&second).unwrap();

        let settings = Settings {
            workspace_path: Some(primary.to_string_lossy().to_string()),
            extra_folders: vec![
                second.to_string_lossy().to_string(),
                // Already the primary, and a folder that is not there any more:
                // neither may add a root.
                primary.to_string_lossy().to_string(),
                root.join("deleted").to_string_lossy().to_string(),
            ],
            ..Settings::default()
        };
        let paths = super::paths_in(root.join("config"));
        write_managed_mcp_config(&paths, &settings).unwrap();

        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.managed_config_path).unwrap()).unwrap();
        let repos = document["repos"].as_array().unwrap();
        assert_eq!(repos.len(), 2, "only the two folders that exist are roots");
        assert_eq!(repos[0]["repo_id"], "workspace");
        assert_eq!(repos[1]["display_name"], "second");
        assert_ne!(repos[0]["repo_id"], repos[1]["repo_id"]);
        // Same protections on every root, however it was added.
        assert_eq!(
            repos[0]["writes"]["denied_globs"],
            repos[1]["writes"]["denied_globs"]
        );

        let _ = fs::remove_dir_all(root);
    }

    /// The managed config under a smart scope: the approved subfolders and
    /// nothing else. This is the file the MCP server reads, so it is the one
    /// place the restriction becomes real - which is why the whole document is
    /// asserted rather than a helper's return value.
    #[test]
    fn writes_only_approved_subfolders_under_a_smart_scope() {
        let root =
            env::temp_dir().join(format!("secret-tunnel-smart-config-{}", std::process::id()));
        let alpha = root.join("alpha");
        let beta = root.join("beta");
        let gamma = root.join("gamma");
        for folder in [
            alpha.join("For-AI"),
            alpha.join("src"),
            beta.join("for-ai"),
            gamma.join("docs"),
        ] {
            fs::create_dir_all(folder).unwrap();
        }
        let canonical = |path: &std::path::Path| {
            super::normalize_windows_verbatim_prefix(
                &fs::canonicalize(path).unwrap().to_string_lossy(),
            )
        };

        let mut settings = Settings {
            workspace_path: Some(canonical(&alpha)),
            extra_folders: vec![canonical(&beta), canonical(&gamma)],
            access_mode: AccessMode::ReadWrite,
            ..Settings::default()
        };
        let paths = super::paths_in(root.join("config"));

        // Broad first, so the difference is the scope and not the fixture.
        write_managed_mcp_config(&paths, &settings).unwrap();
        let broad: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.managed_config_path).unwrap()).unwrap();
        assert_eq!(broad["repos"].as_array().unwrap().len(), 3);

        settings.smart_scope = Some(super::SmartScope {
            name: "For-AI".to_string(),
            matches: vec![
                super::SmartFolderMatch {
                    project: canonical(&alpha),
                    folder: canonical(&alpha.join("For-AI")),
                },
                super::SmartFolderMatch {
                    project: canonical(&beta),
                    folder: canonical(&beta.join("for-ai")),
                },
            ],
        });
        write_managed_mcp_config(&paths, &settings).unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.managed_config_path).unwrap()).unwrap();
        let repos = document["repos"].as_array().unwrap();

        assert_eq!(repos.len(), 2, "only the approved subfolders are roots");
        let roots: Vec<&str> = repos
            .iter()
            .map(|repo| repo["root"].as_str().unwrap())
            .collect();
        assert!(roots.contains(&canonical(&alpha.join("For-AI")).as_str()));
        assert!(roots.contains(&canonical(&beta.join("for-ai")).as_str()));
        // Neither a project root nor the unmatched project is reachable, and
        // the old workspace id is not handed to a subfolder.
        for absent in [canonical(&alpha), canonical(&beta), canonical(&gamma)] {
            assert!(!roots.contains(&absent.as_str()));
        }
        for repo in repos {
            assert_ne!(repo["repo_id"], "workspace");
            assert!(repo["repo_id"].as_str().unwrap().starts_with("smart-"));
            // Read/write mode, the deny list and the byte limit are the same
            // protections every root has always had.
            assert_eq!(repo["writes"]["enabled"], true);
            assert_eq!(repo["writes"]["max_bytes_per_write"], 1048576);
            assert_eq!(
                repo["writes"]["denied_globs"],
                broad["repos"][0]["writes"]["denied_globs"]
            );
            assert_eq!(repo["operations"]["enabled"], false);
        }
        assert!(repos
            .iter()
            .any(|repo| repo["display_name"] == "alpha/For-AI"));
        assert_eq!(document["limits"], broad["limits"]);

        // Read mode still wins: a scope narrows where writes may land, it never
        // turns writing on.
        settings.access_mode = AccessMode::Read;
        write_managed_mcp_config(&paths, &settings).unwrap();
        let read_only: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.managed_config_path).unwrap()).unwrap();
        for repo in read_only["repos"].as_array().unwrap() {
            assert_eq!(repo["writes"]["enabled"], false);
        }

        // A scope that can no longer be honoured stops the config being
        // written at all, rather than being rewritten with broad roots.
        fs::remove_dir_all(alpha.join("For-AI")).unwrap();
        fs::remove_dir_all(beta.join("for-ai")).unwrap();
        let error = write_managed_mcp_config(&paths, &settings).unwrap_err();
        assert_eq!(error.code, "smart_scope_unavailable");
        let unchanged: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.managed_config_path).unwrap()).unwrap();
        assert_eq!(unchanged["repos"].as_array().unwrap().len(), 2);

        let _ = fs::remove_dir_all(root);
    }

    /// Set up a previous-generation profile with the shape a real one has.
    fn previous_generation_profile(name: &str) -> std::path::PathBuf {
        let root = env::temp_dir().join(format!(
            "secret-tunnel-carry-test-{}-{}",
            std::process::id(),
            name
        ));
        let from = root.join("v2");
        fs::create_dir_all(from.join("zrok-home/identities")).unwrap();
        fs::create_dir_all(from.join(".activation/inbox")).unwrap();
        fs::create_dir_all(from.join("github-operations-v1")).unwrap();
        let settings = Settings {
            workspace_path: Some(r"D:\GitHub\Example".to_string()),
            access_mode: AccessMode::ReadWrite,
            zrok_name: "gptmcpd279190c65df".to_string(),
            public_path_token: "1d86323c6e414f829b4c174917d3d4dc".to_string(),
            ..Settings::default()
        };
        save_settings(&super::paths_in(from.clone()), &settings).unwrap();
        fs::write(from.join("github-account.json"), "account").unwrap();
        fs::write(from.join("zrok-home/environment.json"), "env").unwrap();
        fs::write(from.join("zrok-home/identities/backend.json"), "id").unwrap();
        fs::write(from.join("zrok-home/agent.socket"), "live").unwrap();
        fs::write(from.join("profile.lock"), "").unwrap();
        fs::write(from.join("profile.meta.json"), "{}").unwrap();
        fs::write(from.join("diagnostics.log"), "old log").unwrap();
        fs::write(from.join("gpt-repo-mcp.config.json"), "derived").unwrap();
        fs::write(from.join(".activation/inbox/ticket.json"), "{}").unwrap();
        fs::write(from.join("github-operations-v1/plan.jsonl"), "{}").unwrap();
        root
    }

    /// The whole point of the copy: the setup arrives, and the state that
    /// describes the installation it came from does not.
    #[test]
    fn carries_the_setup_and_leaves_the_state_behind() {
        let root = previous_generation_profile("setup");
        let from = root.join("v2");
        let to = root.join("v3");

        assert!(carry_profile(&from, &to));

        let carried = load_settings(&super::paths_in(to.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            carried.workspace_path.as_deref(),
            Some(r"D:\GitHub\Example")
        );
        assert_eq!(carried.access_mode, AccessMode::ReadWrite);
        assert_eq!(
            fs::read_to_string(to.join("github-account.json")).unwrap(),
            "account"
        );
        assert_eq!(
            fs::read_to_string(to.join("zrok-home/identities/backend.json")).unwrap(),
            "id"
        );
        for state in [
            "profile.lock",
            "profile.meta.json",
            "diagnostics.log",
            "gpt-repo-mcp.config.json",
            ".activation",
            "github-operations-v1",
            "zrok-home/agent.socket",
        ] {
            assert!(!to.join(state).exists(), "{state} should not have carried");
        }
        // Copying, never moving: the older installation still has everything.
        assert!(from.join("settings.json").is_file());
        assert!(from.join("zrok-home/environment.json").is_file());

        let _ = fs::remove_dir_all(root);
    }

    /// Two generations must never claim one public address. Inheriting the
    /// reserved name would point the stale-share cleanup straight at the older
    /// installation's live tunnel.
    #[test]
    fn carrying_a_profile_takes_a_new_public_address() {
        let root = previous_generation_profile("address");
        let from = root.join("v2");
        let to = root.join("v3");

        assert!(carry_profile(&from, &to));

        let before = load_settings(&super::paths_in(from.clone()))
            .unwrap()
            .unwrap();
        let after = load_settings(&super::paths_in(to.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(before.zrok_name, "gptmcpd279190c65df");
        assert_ne!(after.zrok_name, before.zrok_name);
        assert_ne!(after.public_path_token, before.public_path_token);
        assert!(validate_zrok_name(&after.zrok_name).is_ok());
        assert!(validate_public_path_token(&after.public_path_token).is_ok());

        let _ = fs::remove_dir_all(root);
    }

    /// Fails closed. A profile that cannot be moved onto an address of its own
    /// is left without settings, so this generation starts as a fresh install
    /// rather than one pointed at an address someone else is serving.
    #[test]
    fn a_profile_that_cannot_take_a_new_address_is_not_carried() {
        let root = previous_generation_profile("unreadable");
        let from = root.join("v2");
        let to = root.join("v3");
        // Valid JSON, wrong shape: it parses, then fails to become Settings.
        fs::write(from.join("settings.json"), "[1, 2, 3]").unwrap();

        assert!(!carry_profile(&from, &to));
        assert!(!to.join("settings.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    /// Seeding is a first-run step only. Once this generation has settings of
    /// its own they are authoritative, however old the previous profile is.
    #[test]
    fn seeding_never_overwrites_an_existing_profile() {
        let root = env::temp_dir().join(format!(
            "secret-tunnel-profile-seed-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("settings.json"), "mine").unwrap();

        seed_from_previous_generation(&root);

        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            "mine"
        );
        let _ = fs::remove_dir_all(root);
    }
}
