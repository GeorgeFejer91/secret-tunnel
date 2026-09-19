//! Authenticated loopback broker (Step 22).
//!
//! The bundled MCP server runs as a separate process, so it needs a way to ask
//! the coordinator questions and submit plans. This is that channel, and its
//! properties are the point:
//!
//! * It binds `127.0.0.1` only, so it is not reachable through the zrok tunnel
//!   even while the tunnel is up.
//! * It requires a bearer token generated fresh each run and handed to the MCP
//!   child through its environment, never through a file in the shared folder —
//!   which would be readable, and writable, over the very connection it guards.
//! * It exposes questions and proposals, never approval. `approve` is not a
//!   route. The only way to authorise a mutation is in the desktop window.
//!
//! A minimal HTTP/1.1 implementation is used rather than a web framework: the
//! surface is four loopback JSON routes, and a dependency that can serve the
//! internet is a poor fit for something that must never leave this machine.

use super::coordinator::GitHubCoordinator;
use super::plan::PlanAction;
use crate::error::AppError;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

/// Refuse bodies larger than this. The legitimate requests are small JSON
/// objects; anything bigger is a mistake or an attempt to exhaust memory.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// Caps on the part of a request that is read *before* the token is checked,
/// and so on behalf of a caller not yet known to be the MCP child. A peer that
/// opens a socket and dribbles header bytes forever would otherwise pin a
/// thread and grow a String without limit.
const MAX_HEADER_LINE_BYTES: u64 = 8 * 1024;
const MAX_HEADER_LINES: usize = 64;

/// How many connections may be in flight at once. The real client issues one
/// request at a time; this only has to stop an unbounded thread fan-out.
const MAX_CONCURRENT_CONNECTIONS: usize = 16;

pub struct Broker {
    pub port: u16,
    pub token: String,
    shutdown: Arc<AtomicBool>,
}

/// Decrements the in-flight count however the connection thread ends, including
/// on an early return or a panic. A hand-written decrement would leak a slot on
/// every error path and eventually refuse all connections.
struct ConnectionSlot(Arc<AtomicUsize>);

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Broker {
    /// Start the broker on an ephemeral loopback port.
    pub fn start(coordinator: Arc<GitHubCoordinator>) -> Result<Self, AppError> {
        // Port 0 asks the OS for a free port, so nothing is guessable and two
        // profiles cannot collide.
        let listener =
            TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|e| {
                AppError::new("broker_bind", format!("Could not start the broker: {e}"))
            })?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::new("broker_addr", e.to_string()))?
            .port();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );

        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let worker_token = token.clone();
        let in_flight = Arc::new(AtomicUsize::new(0));

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if worker_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };

                // Count the slot before spawning; a thread that cannot get one
                // is never created, and the peer is simply dropped.
                if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_CONNECTIONS {
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    drop(stream);
                    continue;
                }
                let slot = ConnectionSlot(in_flight.clone());
                let coordinator = coordinator.clone();
                let token = worker_token.clone();
                std::thread::spawn(move || {
                    let _slot = slot;
                    let _ = handle(stream, &coordinator, &token);
                });
            }
        });

        Ok(Self {
            port,
            token,
            shutdown,
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // `incoming()` blocks in accept(), so setting the flag alone would leave
        // the thread parked until some unrelated peer happened to connect.
        // Connecting once wakes it so it can observe the flag and return.
        let _ = std::net::TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port));
    }
}

/// Read one header line, refusing one that runs on beyond the cap. Returns the
/// number of bytes consumed, so an over-long line is a hard failure rather than
/// a silent truncation that would let a header be smuggled past the limit.
fn read_header_line(
    reader: &mut BufReader<TcpStream>,
    line: &mut String,
) -> std::io::Result<usize> {
    use std::io::ErrorKind;
    let read = (reader as &mut dyn BufRead)
        .take(MAX_HEADER_LINE_BYTES)
        .read_line(line)?;
    if read as u64 == MAX_HEADER_LINE_BYTES && !line.ends_with('\n') {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "header too long",
        ));
    }
    Ok(read)
}

fn handle(
    mut stream: TcpStream,
    coordinator: &GitHubCoordinator,
    token: &str,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(15)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    read_header_line(&mut reader, &mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut content_length = 0usize;
    let mut authorization = String::new();
    for _ in 0..MAX_HEADER_LINES {
        let mut line = String::new();
        if read_header_line(&mut reader, &mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        } else if lower.starts_with("authorization:") {
            authorization = line["authorization:".len()..].trim().to_string();
        }
    }

    if content_length > MAX_BODY_BYTES {
        return respond(&mut stream, 413, &json!({ "error": "request too large" }));
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    // Constant-ish comparison: length first, then bytes. The token is random
    // and long, so this is defence in depth rather than the primary control.
    let presented = authorization.strip_prefix("Bearer ").unwrap_or("");
    if presented.len() != token.len()
        || !presented
            .bytes()
            .zip(token.bytes())
            .fold(true, |acc, (a, b)| acc & (a == b))
    {
        return respond(&mut stream, 401, &json!({ "error": "unauthorized" }));
    }

    if method != "POST" {
        return respond(&mut stream, 405, &json!({ "error": "method not allowed" }));
    }

    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let result = route(&path, &input, coordinator);

    match result {
        Ok(value) => respond(&mut stream, 200, &value),
        Err(error) => respond(
            &mut stream,
            400,
            &json!({ "error": { "code": error.code, "message": error.message } }),
        ),
    }
}

/// The broker's entire surface. Note what is absent: there is no approve route.
pub(super) fn route(
    path: &str,
    input: &Value,
    coordinator: &GitHubCoordinator,
) -> Result<Value, AppError> {
    // Only persistence, not pairing creation, profile export, or authorization.
    if path == "/network/state" {
        let fields = input
            .as_object()
            .ok_or_else(|| AppError::new("invalid_input", "Expected an object."))?;
        if fields.keys().any(|key| key != "action" && key != "state") {
            return Err(AppError::new(
                "invalid_input",
                "Unknown network storage field.",
            ));
        }
        return crate::network::storage(input);
    }
    // Smart folders restricts this endpoint to approved subfolders, and no
    // GitHub route can be narrowed to one: they all act on the whole bound
    // repository. Refused here, at the route, so a client holding a cached tool
    // list gets the refusal too - and refused before the argument shapes are
    // even considered, including the route that hands out a credential for the
    // direct path. The binding stays stored; restoring full access restores it.
    if path.starts_with("/github/") {
        crate::smart_folders::guard_broad_capability(&coordinator.settings()?)?;
    }
    let allowed: &[&str] = match path {
        "/runtime/status" | "/github/status" | "/github/pages_context" => &[],
        "/github/direct_credential" => &[],
        "/github/pages_ensure" => &["domain", "httpsEnforced"],
        "/github/plan" => &["action", "paths", "message"],
        "/github/repo_ship" => &["paths", "message"],
        "/github/create_repository" => &["name"],
        "/github/repo_ensure" => &["name", "visibility"],
        "/github/repo_rebind" => &[
            "expectedOwner",
            "expectedRepo",
            "targetOwner",
            "targetRepo",
            "branch",
        ],
        "/github/apply" | "/github/create_repository/apply" | "/github/operation_status" => {
            &["planId"]
        }
        _ => return Err(AppError::new("unknown_route", "No such broker route.")),
    };
    let fields = input
        .as_object()
        .ok_or_else(|| AppError::new("invalid_input", "Expected a JSON object."))?;
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(AppError::new("invalid_input", "Unknown request field."));
    }
    if let Some(paths) = input.get("paths") {
        if paths.as_array().map_or(true, |items| {
            items.len() > 50 || items.iter().any(|v| !v.is_string())
        }) {
            return Err(AppError::new(
                "invalid_paths",
                "Expected at most fifty path strings.",
            ));
        }
    }
    match path {
        // Identity plus whether this installation may act and as whom. Both
        // are cheap and neither needs a workspace, which is what makes this
        // the route that still answers when everything else is broken.
        "/runtime/status" => {
            let mut value = serde_json::to_value(coordinator.runtime_identity())
                .map_err(|e| AppError::new("serialize", e.to_string()))?;
            let authorization = serde_json::to_value(coordinator.authorization()?)
                .map_err(|e| AppError::new("serialize", e.to_string()))?;
            if let (Some(target), Some(extra)) = (value.as_object_mut(), authorization.as_object())
            {
                target.extend(extra.clone());
            }
            Ok(value)
        }
        // The one route that hands a credential to the MCP child, so that the
        // direct path can genuinely call GitHub itself rather than asking the
        // app to do it and relabelling the result. It is reachable only on
        // loopback with the bearer token the child was started with.
        "/github/direct_credential" => {
            let (token, login) = coordinator.direct_credential()?;
            Ok(json!({ "token": token, "login": login }))
        }
        "/github/operation_status" => {
            let id = input
                .get("planId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("missing_plan_id", "planId is required."))?;
            serde_json::to_value(coordinator.operation_status(id)?)
                .map_err(|e| AppError::new("serialize", e.to_string()))
        }
        "/github/status" => {
            let status = coordinator.status()?;
            serde_json::to_value(status).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        "/github/plan" => {
            let action = match input.get("action").and_then(Value::as_str).unwrap_or("") {
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
            let paths = input
                .get("paths")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let message = input
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string);
            let plan = coordinator.create_plan(action, paths, message)?;
            serde_json::to_value(plan).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        "/github/apply" => {
            let plan_id = input
                .get("planId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("missing_plan_id", "planId is required."))?;
            let outcome = coordinator.apply(plan_id)?;
            serde_json::to_value(outcome).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        // Creating a repository produces no commit, so it has its own route
        // rather than overloading apply's commit-shaped result.
        "/github/create_repository" => {
            let name = input
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("missing_name", "name is required."))?;
            let plan = coordinator.create_repository_plan(name)?;
            serde_json::to_value(plan).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        "/github/create_repository/apply" => {
            let plan_id = input
                .get("planId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("missing_plan_id", "planId is required."))?;
            let created = coordinator.create_repository(plan_id)?;
            serde_json::to_value(created).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        // Writes the minimal Actions Pages workflow when absent and switches
        // Pages on. Publishing the workflow is a separate ship.
        "/github/pages_ensure" => {
            let domain = match input.get("domain") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.clone()),
                Some(_) => {
                    return Err(AppError::new(
                        "invalid_input",
                        "domain must be a hostname string.",
                    ))
                }
            };
            let https_enforced = match input.get("httpsEnforced") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(value)) => *value,
                Some(_) => {
                    return Err(AppError::new(
                        "invalid_input",
                        "httpsEnforced must be true or false.",
                    ))
                }
            };
            if https_enforced && domain.is_none() {
                return Err(AppError::new(
                    "invalid_input",
                    "HTTPS can only be enforced for a custom domain.",
                ));
            }
            let setup = coordinator.ensure_pages(domain, https_enforced)?;
            serde_json::to_value(setup).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        // Commit the exact reviewed paths and publish them in one call. Same
        // plan engine, same checks, same receipt; the only difference is that
        // the configured execution mode authorises it.
        "/github/repo_ship" => {
            let paths = input
                .get("paths")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let message = input
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("no_message", "A commit message is required."))?;
            let receipt = coordinator.ship(paths, message.to_string())?;
            serde_json::to_value(receipt).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        // Creates a repository — private unless asked for a public one — only
        // when the workspace has no usable binding, then initialises, points
        // origin at it and binds.
        "/github/repo_ensure" => {
            let name = input
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
            // Absent means private, which is what every caller before this
            // field got; only the exact word "public" opens a new repository.
            let private = match input.get("visibility") {
                None | Some(Value::Null) => true,
                Some(Value::String(value)) if value == "private" => true,
                Some(Value::String(value)) if value == "public" => false,
                Some(_) => {
                    return Err(AppError::new(
                        "invalid_input",
                        "visibility must be \"private\" or \"public\".",
                    ))
                }
            };
            let ensured = coordinator.ensure_repository(name, private)?;
            serde_json::to_value(ensured).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        // Deliberately retargets an existing binding, which `repo_ensure`
        // refuses to do on its own. The caller states the binding it believes
        // is current and the whole call refuses if that is not what is there.
        "/github/repo_rebind" => {
            let text = |field: &str| -> Result<String, AppError> {
                input
                    .get(field)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| AppError::new("invalid_input", format!("{field} is required.")))
            };
            let branch = match input.get("branch") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.clone()),
                Some(_) => return Err(AppError::new("invalid_input", "branch must be a string.")),
            };
            let outcome = coordinator.rebind_repository(
                &text("expectedOwner")?,
                &text("expectedRepo")?,
                &text("targetOwner")?,
                &text("targetRepo")?,
                branch,
            )?;
            serde_json::to_value(outcome).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        // Read-only: resolves the bound repository identity and current head
        // for the Pages verifier. Creates nothing and publishes nothing.
        "/github/pages_context" => {
            let context = coordinator.pages_context()?;
            serde_json::to_value(context).map_err(|e| AppError::new("serialize", e.to_string()))
        }
        _ => Err(AppError::new("unknown_route", "No such broker route.")),
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )?;
    stream.write_all(&payload)?;
    stream.flush()
}
