//! Bounded, typed process execution for the GitHub feature.
//!
//! Everything the GitHub coordinator runs goes through here. The contract is
//! deliberately narrow, because the alternative — letting a caller hand over a
//! program name and an argument string — is how a file-sharing app turns into
//! remote code execution.
//!
//! * The program is chosen from a closed set of [`Tool`]s, never from a string.
//! * Arguments are an owned `Vec<String>` passed straight to the OS. No shell
//!   is involved, so quoting, `&&`, `|`, `$(...)` and friends are ordinary
//!   characters in an argument rather than syntax.
//! * stdin is closed. Nothing can block waiting to be fed.
//! * stdout and stderr are captured concurrently and truncated, so a chatty or
//!   runaway child cannot exhaust memory or deadlock on a full pipe.
//! * Every run has a deadline and can be cancelled; on either the process tree
//!   is terminated rather than leaked.
//! * The environment is rebuilt rather than inherited.
//! * Output is redacted before it is stored or returned.

use crate::error::AppError;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Hard ceiling on captured output per stream. Git can be extremely verbose;
/// anything past this is not worth the memory and is truncated with a marker.
pub const MAX_CAPTURED_BYTES: usize = 1_000_000;

/// Default wall-clock budget for one invocation.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(60);

/// The closed set of programs this feature may execute.
///
/// A caller names the tool; it never supplies a path or a program name. Adding
/// a variant is a deliberate, reviewable act.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Git,
    GitHubCli,
}

impl Tool {
    pub fn as_str(self) -> &'static str {
        match self {
            Tool::Git => "git",
            Tool::GitHubCli => "gh",
        }
    }
}

/// A resolved, absolute path to a trusted executable plus the version string it
/// reported. Resolution happens once; the absolute path is then used for every
/// invocation so a later PATH change cannot substitute a different binary.
#[derive(Debug, Clone)]
pub struct ResolvedTool {
    pub tool: Tool,
    pub path: PathBuf,
    pub version: String,
}

/// Outcome of one bounded invocation.
#[derive(Debug, Clone)]
pub struct CommandOutcome {
    /// Correlates this run with the audit record and any receipt.
    pub operation_id: String,
    pub tool: Tool,
    /// The exact argv handed to the OS, redacted for storage.
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration: Duration,
    pub timed_out: bool,
    pub cancelled: bool,
}

impl CommandOutcome {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out && !self.cancelled
    }
}

/// A run that has been fully specified by internal code.
pub struct CommandSpec {
    tool: ResolvedTool,
    args: Vec<String>,
    cwd: PathBuf,
    deadline: Duration,
    /// Extra environment entries layered onto the sanitized base.
    env: Vec<(String, String)>,
    /// Values to mask in captured output and stored argv.
    secrets: Vec<String>,
    /// Internal bounded stdin. It is never included in an audit record.
    input: Option<Vec<u8>>,
}

impl CommandSpec {
    pub fn new(tool: ResolvedTool, cwd: impl Into<PathBuf>) -> Self {
        Self {
            tool,
            args: Vec::new(),
            cwd: cwd.into(),
            deadline: DEFAULT_DEADLINE,
            env: Vec::new(),
            secrets: Vec::new(),
            input: None,
        }
    }

    /// Append one argument. Each call contributes exactly one argv entry, so a
    /// value containing spaces or shell metacharacters stays a single argument.
    pub fn arg(mut self, value: impl Into<String>) -> Self {
        self.args.push(value.into());
        self
    }

    pub fn args<I, S>(mut self, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(values.into_iter().map(Into::into));
        self
    }

    pub fn deadline(mut self, deadline: Duration) -> Self {
        self.deadline = deadline;
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn input(mut self, bytes: Vec<u8>) -> Self {
        self.input = Some(bytes);
        self
    }

    /// Register a value that must never appear in captured output or in the
    /// recorded argv.
    pub fn secret(mut self, value: impl Into<String>) -> Self {
        let value = value.into();
        if !value.is_empty() {
            self.secrets.push(value);
        }
        self
    }
}

/// Cancels in-flight work. Cloned into callers; setting it makes the executor
/// terminate the child at its next check.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Run a fully specified command to completion, or until its deadline or
/// cancellation, whichever comes first.
pub fn run(spec: CommandSpec, cancel: &CancelToken) -> Result<CommandOutcome, AppError> {
    let operation_id = fresh_operation_id();
    let started = Instant::now();
    if spec
        .input
        .as_ref()
        .map_or(false, |b| b.len() > 64 * 1024 * 1024)
    {
        return Err(AppError::new(
            "github_input_limit",
            "Internal command input exceeds its limit.",
        ));
    }

    let mut command = Command::new(&spec.tool.path);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(if spec.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_sanitized_environment(&mut command, &spec.env);
    crate::process::suppress_console_window(&mut command);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::new(
            "github_exec_spawn",
            format!("Could not run {}: {error}", spec.tool.tool.as_str()),
        )
    })?;
    let pid = child.id();
    let process_job = match crate::actions::execution_job::Job::attach(&child) {
        Ok(job) => Some(job),
        Err(error) => {
            // Very short probes can finish before Windows can attach a job.
            if child.try_wait().ok().flatten().is_some() {
                None
            } else {
                stop_owned_group(pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    };
    let input_writer = match (spec.input.as_ref(), child.stdin.take()) {
        (Some(bytes), Some(mut pipe)) => {
            let bytes = bytes.clone();
            Some(std::thread::spawn(move || {
                use std::io::Write;
                pipe.write_all(&bytes)
            }))
        }
        _ => None,
    };

    // Drain both pipes on their own threads. Waiting for exit first would
    // deadlock as soon as a child fills a pipe buffer, which git does readily.
    let stdout_capture = spawn_reader(child.stdout.take());
    let stderr_capture = spawn_reader(child.stderr.take());

    let mut timed_out = false;
    let mut cancelled = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(error) => {
                stop_owned_group(pid);
                let _ = child.kill();
                return Err(AppError::new(
                    "github_exec_wait",
                    format!("Could not wait for {}: {error}", spec.tool.tool.as_str()),
                ));
            }
        }

        if cancel.is_cancelled() {
            cancelled = true;
        } else if started.elapsed() >= spec.deadline {
            timed_out = true;
        }

        if cancelled || timed_out {
            // Terminate the whole tree: git spawns helpers (pagers, credential
            // helpers, ssh) that would otherwise outlive it.
            crate::process::kill_process_tree(pid);
            stop_owned_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }

        std::thread::sleep(Duration::from_millis(25));
    };

    // A successful parent exit is not permission to leak helpers holding pipes.
    drop(process_job);
    stop_owned_group(pid);
    let pipe_deadline = started + spec.deadline + Duration::from_secs(2);
    if let Some(writer) = input_writer {
        while !writer.is_finished() {
            if Instant::now() >= pipe_deadline {
                return Err(AppError::new(
                    "github_pipe_timeout",
                    "Command input pipe did not terminate.",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let written = writer
            .join()
            .map_err(|_| AppError::new("github_stdin_failed", "Command input writer failed."))?;
        if exit_code == Some(0) {
            written.map_err(|_| {
                AppError::new("github_stdin_failed", "Command did not consume its input.")
            })?;
        }
    }
    let (stdout_raw, stdout_truncated) = collect(stdout_capture, pipe_deadline)?;
    let (stderr_raw, stderr_truncated) = collect(stderr_capture, pipe_deadline)?;

    Ok(CommandOutcome {
        operation_id,
        tool: spec.tool.tool,
        args: spec
            .args
            .iter()
            .map(|arg| redact(arg, &spec.secrets))
            .collect(),
        exit_code,
        stdout: redact(&stdout_raw, &spec.secrets),
        stderr: redact(&stderr_raw, &spec.secrets),
        stdout_truncated,
        stderr_truncated,
        duration: started.elapsed(),
        timed_out,
        cancelled,
    })
}

/// Build the child environment from a known-good base rather than inheriting
/// the parent's. An inherited environment can carry `GIT_*` overrides, proxy
/// settings, credential helpers and pager configuration that would change what
/// the command does.
fn apply_sanitized_environment(command: &mut Command, extra: &[(String, String)]) {
    command.env_clear();

    // Sanitizing is not the same as emptying. Git is invoked by absolute path,
    // but it legitimately spawns its own helpers - ssh, credential managers,
    // hooks - and resolves them through PATH, and it finds user configuration
    // through the home variables. Clearing those does not make anything safer;
    // it just makes git fail in ways that look like network errors. What is
    // deliberately dropped is everything else, notably any inherited GIT_*
    // override that would silently change what a command does.
    let preserved: HashSet<&str> = if cfg!(windows) {
        [
            "PATH",
            "PATHEXT",
            "SystemRoot",
            "SystemDrive",
            "windir",
            "TEMP",
            "TMP",
            "COMSPEC",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
        ]
        .into_iter()
        .collect()
    } else {
        ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK"]
            .into_iter()
            .collect()
    };
    for key in preserved {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }

    // Git must not stop for a pager, a prompt, or an interactive credential
    // helper: nothing can answer, so it would simply hang until the deadline.
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C");

    for (key, value) in extra {
        command.env(key, value);
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    stream: Option<R>,
) -> Option<std::thread::JoinHandle<(String, bool)>> {
    let mut stream = stream?;
    Some(std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if buffer.len() < MAX_CAPTURED_BYTES {
                        let room = MAX_CAPTURED_BYTES - buffer.len();
                        buffer.extend_from_slice(&chunk[..read.min(room)]);
                        if read > room {
                            truncated = true;
                        }
                    } else {
                        // Keep draining so the child never blocks on a full
                        // pipe, but stop accumulating.
                        truncated = true;
                    }
                }
                Err(_) => break,
            }
        }
        (String::from_utf8_lossy(&buffer).to_string(), truncated)
    }))
}

fn collect(
    handle: Option<std::thread::JoinHandle<(String, bool)>>,
    deadline: Instant,
) -> Result<(String, bool), AppError> {
    match handle {
        Some(handle) => {
            while !handle.is_finished() {
                if Instant::now() >= deadline {
                    return Err(AppError::new(
                        "github_pipe_timeout",
                        "Command output pipe did not terminate.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            handle
                .join()
                .map_err(|_| AppError::new("github_pipe_failed", "Command output reader failed."))
        }
        None => Ok((String::new(), false)),
    }
}

fn stop_owned_group(pid: u32) {
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        if pid <= i32::MAX as u32 {
            // Child was launched in its own process group; never signal our group.
            unsafe {
                kill(-(pid as i32), 9);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

/// Replace known secret values with a marker. Applied to argv and to both
/// streams before anything is stored, logged or returned.
fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        // Very short values would match everywhere and destroy the output's
        // usefulness without meaningfully protecting anything.
        if secret.len() >= 4 {
            out = out.replace(secret.as_str(), "[redacted]");
        }
    }
    out
}

fn fresh_operation_id() -> String {
    format!("op-{}", uuid::Uuid::new_v4().simple())
}

/// Resolve a tool to an absolute path and record the version it reports.
///
/// Resolution is the only place PATH is consulted. Everything afterwards uses
/// the absolute path, so a directory appearing earlier on PATH later in the
/// session cannot substitute a different binary mid-operation.
pub fn resolve_tool(tool: Tool) -> Result<ResolvedTool, AppError> {
    let path = which(tool.as_str()).ok_or_else(|| {
        AppError::new(
            "github_tool_missing",
            format!(
                "{} was not found. Install it and restart Secret Tunnel.",
                tool.as_str()
            ),
        )
    })?;

    let probe = CommandSpec::new(
        ResolvedTool {
            tool,
            path: path.clone(),
            version: String::new(),
        },
        std::env::temp_dir(),
    )
    .arg("--version")
    .deadline(Duration::from_secs(15));

    let outcome = run(probe, &CancelToken::new())?;
    if !outcome.success() {
        return Err(AppError::new(
            "github_tool_unusable",
            format!(
                "{} at {} did not report a version.",
                tool.as_str(),
                path.display()
            ),
        ));
    }

    Ok(ResolvedTool {
        tool,
        path,
        version: outcome.stdout.trim().to_string(),
    })
}

/// Locate an executable on PATH, returning an absolute path.
fn which(program: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string())
            .split(';')
            .filter(|ext| !ext.trim().is_empty())
            .map(|ext| format!("{program}{}", ext.to_ascii_lowercase()))
            .collect()
    } else {
        vec![program.to_string()]
    };

    for directory in std::env::split_paths(&path_var) {
        for candidate in &candidates {
            let full = directory.join(candidate);
            if is_executable_file(&full) {
                return full.canonicalize().ok().or(Some(full));
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Shared audit trail of every invocation, for receipts and diagnostics.
#[derive(Clone, Default)]
pub struct AuditLog(Arc<Mutex<Vec<AuditEntry>>>);

#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub operation_id: String,
    pub tool: &'static str,
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    pub timed_out: bool,
    pub cancelled: bool,
}

impl AuditLog {
    pub fn record(&self, outcome: &CommandOutcome) {
        let entry = AuditEntry {
            operation_id: outcome.operation_id.clone(),
            tool: outcome.tool.as_str(),
            args: outcome.args.clone(),
            exit_code: outcome.exit_code,
            duration_ms: outcome.duration.as_millis(),
            timed_out: outcome.timed_out,
            cancelled: outcome.cancelled,
        };
        if let Ok(mut entries) = self.0.lock() {
            entries.push(entry);
        }
    }

    pub fn entries(&self) -> Vec<AuditEntry> {
        self.0.lock().map(|e| e.clone()).unwrap_or_default()
    }
}
