//! T03 - bounded typed execution (For-AI/PLANNER/github-sync/TEST_PLAN.md).
//!
//! These use the host's own shell interpreter as a stand-in child, because it
//! is guaranteed present and its behaviour with metacharacters is exactly what
//! must be proven inert.

use super::exec::{run, CancelToken, CommandSpec, ResolvedTool, Tool, MAX_CAPTURED_BYTES};
use std::path::PathBuf;
use std::time::Duration;

/// A resolved tool pointing at a program we can drive deterministically.
fn shell_tool() -> ResolvedTool {
    let path = if cfg!(windows) {
        PathBuf::from(
            std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()),
        )
    } else {
        PathBuf::from("/bin/sh")
    };
    ResolvedTool {
        tool: Tool::Git,
        path,
        version: "test".to_string(),
    }
}

/// Run `body` through the shell, used only to produce controlled output.
fn shell(body: &str) -> CommandSpec {
    let spec = CommandSpec::new(shell_tool(), std::env::temp_dir());
    if cfg!(windows) {
        spec.arg("/C").arg(body)
    } else {
        spec.arg("-c").arg(body)
    }
}

#[test]
fn t03_captures_stdout_and_exit_code() {
    let outcome = run(shell("echo hello-from-child"), &CancelToken::new()).unwrap();
    assert!(outcome.success(), "stderr: {}", outcome.stderr);
    assert!(outcome.stdout.contains("hello-from-child"));
    assert_eq!(outcome.exit_code, Some(0));
    assert!(!outcome.operation_id.is_empty());
}

#[test]
fn t03_reports_a_nonzero_exit_code() {
    let outcome = run(shell("exit 3"), &CancelToken::new()).unwrap();
    assert_eq!(outcome.exit_code, Some(3));
    assert!(!outcome.success());
}

/// The core of T03. A value containing shell metacharacters must arrive at the
/// child as one argument, not as syntax. If the executor ever routed through a
/// shell, the marker file would be created and this would fail.
#[test]
fn t03_metacharacters_in_values_are_data_not_syntax() {
    let dir = std::env::temp_dir().join(format!("st-exec-meta-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("pwned.txt");
    let _ = std::fs::remove_file(&marker);

    // A single argument that would be catastrophic if interpreted.
    let hostile = if cfg!(windows) {
        format!("value & echo pwned > \"{}\"", marker.display())
    } else {
        format!("value; echo pwned > '{}'", marker.display())
    };

    let spec = CommandSpec::new(shell_tool(), &dir)
        .arg(if cfg!(windows) { "/C" } else { "-c" })
        .arg(if cfg!(windows) { "echo" } else { "echo \"$0\"" })
        .arg(&hostile);
    let outcome = run(spec, &CancelToken::new()).unwrap();

    assert!(
        !marker.exists(),
        "argument was interpreted as shell syntax and executed"
    );
    assert!(
        outcome.stdout.contains("value"),
        "argument should have been echoed as data: {}",
        outcome.stdout
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A child that never exits must be stopped at the deadline rather than
/// hanging the caller.
#[test]
fn t03_enforces_a_deadline_and_kills_the_child() {
    let body = if cfg!(windows) {
        "ping -n 60 127.0.0.1 > nul"
    } else {
        "sleep 60"
    };
    let started = std::time::Instant::now();
    let outcome = run(
        shell(body).deadline(Duration::from_secs(2)),
        &CancelToken::new(),
    )
    .unwrap();

    assert!(outcome.timed_out, "should have timed out");
    assert!(!outcome.success());
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "deadline was not enforced; took {:?}",
        started.elapsed()
    );
}

/// Cancellation must take effect without waiting for the deadline.
#[test]
fn t03_cancellation_stops_a_running_child() {
    let body = if cfg!(windows) {
        "ping -n 60 127.0.0.1 > nul"
    } else {
        "sleep 60"
    };
    let cancel = CancelToken::new();
    let signal = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        signal.cancel();
    });

    let started = std::time::Instant::now();
    let outcome = run(shell(body).deadline(Duration::from_secs(120)), &cancel).unwrap();

    assert!(outcome.cancelled, "should report cancellation");
    assert!(!outcome.success());
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "cancellation was not honoured; took {:?}",
        started.elapsed()
    );
}

/// A child that writes more than the cap must be truncated rather than
/// exhausting memory, and must not deadlock on a full pipe.
#[test]
fn t03_truncates_oversized_output_without_deadlocking() {
    // Roughly 2 MB, comfortably over MAX_CAPTURED_BYTES.
    let body = if cfg!(windows) {
        "for /L %i in (1,1,20000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    } else {
        "i=0; while [ $i -lt 20000 ]; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; i=$((i+1)); done"
    };

    let outcome = run(
        shell(body).deadline(Duration::from_secs(120)),
        &CancelToken::new(),
    )
    .unwrap();

    assert!(
        outcome.stdout.len() <= MAX_CAPTURED_BYTES + 8192,
        "captured {} bytes, above the cap",
        outcome.stdout.len()
    );
    assert!(outcome.stdout_truncated, "truncation should be reported");
}

/// Registered secrets must not survive into the recorded argv or the output.
#[test]
fn t03_redacts_secrets_from_output_and_recorded_args() {
    let secret = "ghp_averysecrettokenvalue123456";
    let outcome = run(
        shell(&format!("echo using {secret} now")).secret(secret),
        &CancelToken::new(),
    )
    .unwrap();

    assert!(
        !outcome.stdout.contains(secret),
        "secret leaked into stdout: {}",
        outcome.stdout
    );
    assert!(outcome.stdout.contains("[redacted]"));
    for arg in &outcome.args {
        assert!(!arg.contains(secret), "secret leaked into recorded argv");
    }
}

/// The environment is rebuilt, so a hostile or merely unhelpful inherited
/// variable cannot change what the child does.
#[test]
fn t03_environment_is_sanitized() {
    std::env::set_var("SECRET_TUNNEL_EXEC_CANARY", "leaked-value");

    let body = if cfg!(windows) {
        "echo [%SECRET_TUNNEL_EXEC_CANARY%]"
    } else {
        "echo \"[${SECRET_TUNNEL_EXEC_CANARY:-}]\""
    };
    let outcome = run(shell(body), &CancelToken::new()).unwrap();

    assert!(
        !outcome.stdout.contains("leaked-value"),
        "inherited environment reached the child: {}",
        outcome.stdout
    );
    std::env::remove_var("SECRET_TUNNEL_EXEC_CANARY");
}

/// Git must never stop for a prompt: nothing can answer it, so it would hang.
#[test]
fn t03_sets_noninteractive_git_environment() {
    let body = if cfg!(windows) {
        "echo [%GIT_TERMINAL_PROMPT%]"
    } else {
        "echo \"[${GIT_TERMINAL_PROMPT:-}]\""
    };
    let outcome = run(shell(body), &CancelToken::new()).unwrap();
    assert!(
        outcome.stdout.contains("[0]"),
        "GIT_TERMINAL_PROMPT should be 0: {}",
        outcome.stdout
    );
}
