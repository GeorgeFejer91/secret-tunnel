//! Durable, private execution receipts. An HTTP response is not the operation.
//! A journal is created exclusively before a side effect. It is never replayed.
use super::account::CreatedRepository;
use super::git::CommitOutcome;
use super::plan::{now_secs, PlanAction};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const CONTRACT_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const MAX_RECORD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Running,
    Succeeded,
    Partial,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    pub name: String,
    pub state: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceipt {
    pub schema_version: u32,
    pub operation_id: String,
    pub instance_id: String,
    pub action: PlanAction,
    #[serde(default)]
    pub expected: Option<super::plan::ExpectedState>,
    pub state: OperationState,
    pub phase: String,
    pub started_at_secs: u64,
    pub updated_at_secs: u64,
    pub commit: Option<CommitOutcome>,
    pub created_repository: Option<CreatedRepository>,
    pub setup: Vec<SetupStep>,
    // Codes only. Raw process output and credentials never enter this journal.
    pub error_code: Option<String>,
}

pub struct OperationJournal {
    root: PathBuf,
    instance_id: String,
}

impl OperationJournal {
    pub fn new(config_dir: &Path, instance_id: String) -> Self {
        Self {
            root: config_dir.join("github-operations-v1"),
            instance_id,
        }
    }

    fn path(&self, id: &str) -> Result<PathBuf, AppError> {
        if !valid_operation_id(id) {
            return Err(AppError::new(
                "invalid_plan_id",
                "Use an issued plan identifier.",
            ));
        }
        Ok(self.root.join(format!("{id}.jsonl")))
    }

    fn ensure_directory(&self) -> Result<(), AppError> {
        if self.root.exists() && fs::symlink_metadata(&self.root)?.file_type().is_symlink() {
            return Err(AppError::new(
                "operation_store_unsafe",
                "The operation store must not be a link.",
            ));
        }
        fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    pub fn begin(&self, id: &str, action: PlanAction) -> Result<OperationReceipt, AppError> {
        self.ensure_directory()?;
        if fs::read_dir(&self.root)?.take(2000).count() >= 2000 {
            return Err(AppError::new("operation_history_full", "Archive private operation history locally before continuing; records are never silently discarded."));
        }
        let receipt = OperationReceipt {
            schema_version: CONTRACT_VERSION,
            operation_id: id.to_string(),
            instance_id: self.instance_id.clone(),
            action,
            expected: None,
            state: OperationState::Running,
            phase: "claimed".to_string(),
            started_at_secs: now_secs(),
            updated_at_secs: now_secs(),
            commit: None,
            created_repository: None,
            setup: Vec::new(),
            error_code: None,
        };
        let bytes = record_bytes(&receipt)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(self.path(id)?).map_err(|_| {
            AppError::new("operation_already_claimed", "This identifier is already claimed or its private journal cannot be created. Read its receipt; do not replay it.")
        })?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(receipt)
    }

    pub fn save(&self, receipt: &mut OperationReceipt) -> Result<(), AppError> {
        let path = self.path(&receipt.operation_id)?;
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() >= MAX_JOURNAL_BYTES {
            return Err(AppError::new(
                "operation_store_unsafe",
                "Operation journal is unsafe or full.",
            ));
        }
        receipt.updated_at_secs = now_secs();
        let bytes = record_bytes(receipt)?;
        let mut file = OpenOptions::new().append(true).open(path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<OperationReceipt>, AppError> {
        let path = self.path(id)?;
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_JOURNAL_BYTES {
            return Err(AppError::new(
                "operation_store_unsafe",
                "Invalid operation journal.",
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_JOURNAL_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(AppError::new(
                "operation_store_unsafe",
                "Operation journal is too large.",
            ));
        }
        // An interrupted append may leave a final incomplete line. Earlier complete
        // snapshots remain evidence, but an incomplete tail can never mean success.
        let complete = bytes.ends_with(b"\n");
        let mut latest: Option<OperationReceipt> = None;
        let mut lines = bytes.split(|b| *b == b'\n').peekable();
        while let Some(line) = lines.next() {
            if line.is_empty() {
                continue;
            }
            if lines.peek().is_none() && !complete {
                break;
            }
            if line.len() > MAX_RECORD_BYTES {
                return Err(AppError::new(
                    "operation_store_corrupt",
                    "Oversized receipt record.",
                ));
            }
            let record: OperationReceipt = serde_json::from_slice(line).map_err(|_| {
                AppError::new(
                    "operation_store_corrupt",
                    "Unreadable receipt. Inspect local state before further writes.",
                )
            })?;
            if record.schema_version != CONTRACT_VERSION || record.operation_id != id {
                return Err(AppError::new(
                    "operation_store_corrupt",
                    "Receipt identity does not match.",
                ));
            }
            latest = Some(record);
        }
        let mut receipt = latest.ok_or_else(|| {
            AppError::new(
                "operation_store_corrupt",
                "An incomplete claim exists; it must not be replayed.",
            )
        })?;
        if !complete
            || (receipt.state == OperationState::Running && receipt.instance_id != self.instance_id)
        {
            receipt.state = OperationState::Unknown;
            receipt.error_code = Some("interrupted_reconcile_required".to_string());
        }
        Ok(Some(receipt))
    }

    pub fn recent(&self) -> Result<Vec<OperationReceipt>, AppError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut receipts = Vec::new();
        for (index, entry) in entries.enumerate() {
            if index >= 2000 {
                return Err(AppError::new(
                    "operation_history_full",
                    "Archive the private operation history locally before continuing.",
                ));
            }
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".jsonl") {
                if valid_operation_id(id) {
                    if let Some(receipt) = self.get(id)? {
                        receipts.push(receipt);
                    }
                }
            }
        }
        receipts.sort_by_key(|r| std::cmp::Reverse(r.updated_at_secs));
        receipts.truncate(5);
        Ok(receipts)
    }
}

fn record_bytes(receipt: &OperationReceipt) -> Result<Vec<u8>, AppError> {
    let mut bytes = serde_json::to_vec(receipt)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(AppError::new(
            "operation_record_too_large",
            "Receipt exceeds its limit.",
        ));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn valid_operation_id(id: &str) -> bool {
    id.len() == 37
        && id.starts_with("plan-")
        && id[5..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
