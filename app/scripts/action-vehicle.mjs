import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const LIMITS = Object.freeze({ buffer: 5, ticketBytes: 131072, scanFiles: 200,
  scanBytes: 4194304, inputBytes: 16777216, logBytes: 65536, steps: 50,
  timeoutMs: 3600000, policyMs: 1800000, historyRecords: 2000, receiptBytes: 524288 });
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const BASE = '.chatgpt/actions';
const TERMINAL = new Set(['succeeded', 'failed', 'verification_failed', 'timed_out',
  'canceled', 'interrupted', 'stale', 'rejected', 'blocked']);
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const assert = (ok, message) => { if (!ok) fail('INVALID_TICKET', message); };
const text = (value, max, name) => assert(typeof value === 'string' && value.length > 0 &&
  value.length <= max && !value.includes('\0'), `${name} must be bounded text.`);
const integer = (value, min, max, name) => assert(Number.isSafeInteger(value) && value >= min && value <= max, `${name} is out of range.`);
function keys(value, allowed, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object.`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `Unknown ${name} field: ${key}`);
}
function array(value, min, max, name) {
  assert(Array.isArray(value) && value.length >= min && value.length <= max, `${name} must contain ${min}–${max} items.`);
}
function relative(value, dot = false) {
  text(value, 512, 'Path');
  if (dot && value === '.') return value;
  assert(!/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && value.split('/').every(p =>
    p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), 'Use a safe project-relative POSIX path.');
  return value;
}
function secretPath(value) {
  return value.split('/').some(p => /^\.env(?:\.|$)/i.test(p) || /^\.(git|ssh|aws|gnupg|local-backup)$/i.test(p) || /\.(pem|key|pfx|p12)$/i.test(p));
}
function dataPath(value) {
  relative(value);
  assert(!secretPath(value) && value.toLowerCase() !== BASE && !value.toLowerCase().startsWith(`${BASE}/`), 'Checks and inputs cannot read secret or action-control paths.');
  return value;
}
function validateStep(step) {
  const common = ['id', 'title', 'kind'];
  if (step?.kind === 'command') {
    keys(step, [...common, 'program', 'args', 'cwd', 'timeout_ms'], 'command');
    text(step.program, 1024, 'Program');
    array(step.args, 0, 100, 'Arguments');
    for (const arg of step.args) assert(typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'), 'Invalid argument.');
  } else if (step?.kind === 'script') {
    keys(step, [...common, 'interpreter', 'body', 'cwd', 'timeout_ms'], 'script');
    assert(['node', 'cmd', 'sh', 'powershell'].includes(step.interpreter), 'Unknown interpreter.');
    text(step.body, 32768, 'Script');
  } else if (step?.kind === 'check') {
    keys(step, [...common, 'check', 'path', 'expected'], 'check');
    assert(['exists', 'absent', 'nonempty', 'contains', 'sha256', 'json'].includes(step.check), 'Unknown check.');
    dataPath(step.path);
    if (step.check === 'contains') text(step.expected, 4096, 'Expected text');
    else if (step.check === 'sha256') assert(typeof step.expected === 'string' && HASH.test(step.expected), 'Expected SHA-256 is required.');
    else assert(step.expected === undefined, 'This check does not take expected.');
  } else fail('INVALID_TICKET', 'Unknown step kind.');
  assert(typeof step.id === 'string' && ID.test(step.id), 'Invalid step ID.');
  text(step.title, 160, 'Step title');
  if (step.kind !== 'check') {
    relative(step.cwd ?? '.', true);
    integer(step.timeout_ms ?? 120000, 100, 600000, 'Step timeout');
  }
}
export function validateTicket(ticket) {
  keys(ticket, ['schema_version', 'workspace_id', 'id', 'revision', 'title', 'summary',
    'outcome', 'effects', 'inputs', 'depends_on', 'steps', 'verification', 'timeout_ms'], 'ticket');
  assert(ticket.schema_version === 1, 'Unsupported schema_version.');
  assert(typeof ticket.workspace_id === 'string' && HASH.test(ticket.workspace_id), 'workspace_id must come from the local Actions window.');
  assert(typeof ticket.id === 'string' && ID.test(ticket.id), 'Use a lower-case ticket ID, digits and hyphens only.');
  integer(ticket.revision, 1, 1000000, 'Revision');
  text(ticket.title, 160, 'Title'); text(ticket.summary, 2000, 'Summary'); text(ticket.outcome, 2000, 'Outcome');
  array(ticket.effects, 0, 16, 'Effects'); ticket.effects.forEach(x => text(x, 240, 'Effect'));
  array(ticket.inputs, 0, 32, 'Inputs'); ticket.inputs.forEach(dataPath);
  assert(new Set(ticket.inputs).size === ticket.inputs.length, 'Duplicate inputs.');
  array(ticket.depends_on ?? [], 0, 5, 'Dependencies');
  for (const dependency of ticket.depends_on ?? []) {
    keys(dependency, ['id', 'revision'], 'dependency');
    assert(typeof dependency.id === 'string' && ID.test(dependency.id) && dependency.id !== ticket.id, 'Invalid dependency ID.');
    integer(dependency.revision, 1, 1000000, 'Dependency revision');
  }
  array(ticket.steps, 1, 40, 'Steps'); array(ticket.verification, 1, 20, 'Verification');
  const all = [...ticket.steps, ...ticket.verification];
  assert(all.length <= LIMITS.steps, 'At most 50 execution and verification steps per pack.');
  all.forEach(validateStep);
  assert(new Set(all.map(s => s.id)).size === all.length, 'Step IDs must be unique across both phases.');
  integer(ticket.timeout_ms ?? 900000, 100, LIMITS.timeoutMs, 'Pack timeout');
  assert(Buffer.byteLength(JSON.stringify(ticket)) <= LIMITS.ticketBytes, 'Ticket is too large.');
  return ticket;
}
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function safePath(root, rel, missing = false) {
  relative(rel, true);
  let current = root;
  for (const part of rel === '.' ? [] : rel.split('/')) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Symbolic links and junctions are not accepted.');
      if (!isInside(root, fs.realpathSync(current))) fail('UNSAFE_PATH', 'Path escaped the selected folder.');
    } catch (error) {
      if (!(missing && error.code === 'ENOENT')) throw error;
    }
  }
  return current;
}
function readBounded(root, rel, maximum) {
  const file = safePath(root, rel);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) fail('UNSAFE_FILE', 'File is not a bounded, ordinary, single-link file.');
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count !== stat.size) fail('FILE_CHANGED', 'File changed while being read.');
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
function writeAtomic(root, rel, content) {
  let parent = '';
  for (const part of path.posix.dirname(rel).split('/')) {
    if (part === '.') continue;
    parent = parent ? `${parent}/${part}` : part;
    const dir = safePath(root, parent, true);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!fs.lstatSync(dir).isDirectory()) fail('UNSAFE_PATH', 'Output parent is not an ordinary directory.');
  }
  const target = safePath(root, rel, true);
  const tempRel = `${rel}.${randomUUID()}.tmp`;
  const temporary = safePath(root, tempRel, true);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { safePath(root, rel, true); fs.renameSync(temporary, target); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
const jsonWrite = (root, rel, value) => writeAtomic(root, rel, `${JSON.stringify(value, null, 2)}\n`);
export function redact(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/((?:authorization|password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)(?:Bearer\s+)?[^\s,"']+/ig, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/https:\/\/[^\s/]+\/t\/[^\s/]+\/mcp/g, '[redacted MCP address]');
}
function safeEnvironment() {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'PATHEXT']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
}
function executable(program, root, cwd) {
  if (program === '$node') return process.execPath;
  if (path.isAbsolute(program)) return program;
  if (program.includes('/') || program.includes('\\')) return safePath(root, relative(program));
  assert(/^[A-Za-z0-9_.+-]+$/.test(program) && !program.startsWith('-'), 'Invalid executable name.');
  const envPath = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const suffixes = process.platform === 'win32' && !path.extname(program) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const dir of envPath.split(path.delimiter).filter(p => path.isAbsolute(p) && !isInside(root, p))) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, program + suffix);
      try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
    }
  }
  fail('PROGRAM_NOT_FOUND', `Executable not found on the non-workspace PATH: ${program}. Install the required tool locally or use an explicit executable path.`);
}
export function killTree(child) {
  if (!child.pid) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve(true); }
    catch (e) { return Promise.resolve(e.code === 'ESRCH'); }
  }
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return new Promise(resolve => {
    const killer = spawn(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', env: safeEnvironment() });
    const timer = setTimeout(() => { killer.kill(); resolve(false); }, 5000);
    killer.on('error', () => { clearTimeout(timer); resolve(false); });
    killer.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
function checkFile(root, step) {
  const candidate = safePath(root, step.path, true);
  if (step.check === 'absent') return { passed: !fs.existsSync(candidate), observation: 'Absence checked.' };
  if (step.check === 'exists') return { passed: fs.existsSync(candidate), observation: 'Existence checked (not freshness).' };
  const bytes = readBounded(root, step.path, LIMITS.inputBytes);
  switch (step.check) {
    case 'nonempty': return { passed: bytes.length > 0, observation: `Observed ${bytes.length} bytes (not freshness).` };
    case 'contains': return { passed: bytes.toString('utf8').includes(step.expected), observation: 'Expected literal text checked.' };
    case 'sha256': { const actual = digest(bytes); return { passed: actual === step.expected, observation: `SHA-256: ${actual}` }; }
    case 'json': { try { JSON.parse(bytes.toString('utf8')); return { passed: true, observation: 'JSON parsed.' }; }
      catch { return { passed: false, observation: 'Invalid JSON.' }; } }
    default: fail('INVALID_TICKET', 'Unknown verification check.');
  }
}

export function vehicleTemplate(workspaceId) {
  return { schema_version: 1, workspace_id: workspaceId, id: 'check-project', revision: 1,
    title: 'Check project documentation', summary: 'Check that the project README exists and is not empty.',
    outcome: 'A recorded, verified documentation check.', effects: ['Reads README.md; writes action reports only.'],
    inputs: ['README.md'], depends_on: [],
    steps: [{ id: 'readme-exists', title: 'Find README', kind: 'check', check: 'exists', path: 'README.md' }],
    verification: [{ id: 'readme-nonempty', title: 'Verify README is not empty', kind: 'check', check: 'nonempty', path: 'README.md' }] };
}
export const AGENT_PROTOCOL = `# Secret Tunnel action vehicle v1\n\nWrite one JSON file per substantial action pack to .chatgpt/actions/inbox/<id>.json.\nCopy template.json and workspace.json first. Creation NEVER grants approval.\nUse the current workspace_id. Lower-case IDs, monotonically increasing revisions.\nBatch related work into at most five pending packs, not one ticket per command.\nA pack may contain up to 50 combined steps and verification checks.\nThe user reviews the exact pack and approves it once, or approves up to five visible packs together.\nNever include credentials. The effects field is a declaration, NOT a sandbox.\n\n## Reusable steps\n- command: {id,title,kind:"command",program,args:[],cwd:".",timeout_ms:120000}.\n  program can be $node (bundled), a local executable name, or an explicit executable path.\n  No shell interpolation. On Windows use a cmd script for .bat/.cmd or npm.cmd.\n- script: {id,title,kind:"script",interpreter:"node"|"cmd"|"sh"|"powershell",body,cwd:".",timeout_ms:120000}.\n  Body is copied to app-private storage. No separate wrapper or feedback code is needed.\n  cmd example: call npm.cmd run build\\r\\nexit /b %errorlevel%\n  Scripts must propagate failure. PowerShell execution policy is NOT bypassed.\n- check: {id,title,kind:"check",check:"exists"|"absent"|"nonempty"|"contains"|"sha256"|"json",path,expected?}.\n  expected is required only for contains and sha256. Paths are project-relative.\n\n## Feedback\nThe runner records each step, exit status, timeout, output tails and verification.\nRead reports/<id>/<attempt-id>/RESULT.json, SUMMARY.md, stdout.log and stderr.log.\nReports are exported copies; the desktop's private records are authoritative.\nThe runner, not the script, decides the receipt state. Exit zero alone is not verified success.\nExistence does not prove an artifact is fresh; add content/hash checks or execute a meaningful test.\ninputs lists files whose current hashes must still match review before execution. It is not a sandbox.\nUse depends_on:[{id,revision}] for prerequisite packs; a failed pack pauses the approved batch.\nTo retry, increment revision; earlier attempts remain. Never fabricate a success report.\nApproval and auto-run policy cannot be set in ticket JSON. Extra fields are rejected.\nAutomatic mode is local, temporary, five packs maximum, and supports built-in checks ONLY.\nArbitrary executables and scripts ALWAYS require explicit local approval.\nNo run is replayed after a crash. An interrupted outcome must be reconciled before retrying.\n`;

export class ActionsController {
  constructor(root, privateRoot) {
    this.root = fs.realpathSync(root);
    fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    this.privateRoot = fs.realpathSync(privateRoot);
    if (isInside(this.root, this.privateRoot) || isInside(this.privateRoot, this.root)) fail('UNSAFE_STORE', 'Private action storage must be outside the shared folder.');
    const stat = fs.statSync(this.root);
    this.identity = `${this.root}\n${stat.dev}\n${stat.ino}`;
    this.workspaceId = digest(this.identity);
    this.store = path.join(this.privateRoot, this.workspaceId);
    fs.mkdirSync(this.store, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.store).isSymbolicLink()) fail('UNSAFE_STORE', 'Private storage cannot be a symbolic link.');
    this.queue = []; this.active = null; this.records = new Map(); this.paused = false;
    this.policy = null; this.errors = []; this.closed = false; this.lastError = null; this.cleanupBlocked = false;
    const history = fs.readdirSync(this.store).filter(n => /^[a-z0-9-]+\.r[0-9]+\.json$/.test(n));
    if (history.length > LIMITS.historyRecords) fail('HISTORY_FULL', 'Private history limit reached. Do not delete decision records: an archive migration is required before more execution.');
    for (const name of history) {
      const record = JSON.parse(readBounded(this.store, name, LIMITS.receiptBytes));
      if (!ID.test(record.id) || !Number.isSafeInteger(record.revision)) fail('STORE_CORRUPT', 'Invalid private receipt.');
      if (!TERMINAL.has(record.status)) {
        record.status = 'interrupted'; record.finished_at = now(); record.error = 'Runner stopped before a terminal receipt. Not replayed; reconcile side effects before retrying.';
        record.verification_status = 'not_run';
        jsonWrite(this.store, name, record);
        this.exportReceipt(record);
      }
      this.records.set(`${record.id}.r${record.revision}`, this.recordSummary(record));
    }
  }
  assertRoot() {
    const stat = fs.statSync(this.root);
    if (`${fs.realpathSync(this.root)}\n${stat.dev}\n${stat.ino}` !== this.identity) fail('WORKSPACE_CHANGED', 'Selected folder identity changed. Reopen Actions.');
  }
  initialize() {
    this.assertRoot();
    jsonWrite(this.root, `${BASE}/workspace.json`, { schema_version: 1, workspace_id: this.workspaceId });
    writeAtomic(this.root, `${BASE}/README.md`, AGENT_PROTOCOL);
    jsonWrite(this.root, `${BASE}/template.json`, vehicleTemplate(this.workspaceId));
    const inbox = safePath(this.root, `${BASE}/inbox`, true);
    fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
    return { workspace_id: this.workspaceId, inbox: `${BASE}/inbox`, template: vehicleTemplate(this.workspaceId) };
  }
  readTicket(filename, maximum = LIMITS.ticketBytes) {
    const raw = readBounded(this.root, `${BASE}/inbox/${filename}`, maximum);
    const ticket = validateTicket(JSON.parse(raw.toString('utf8')));
    if (filename !== `${ticket.id}.json`) fail('ID_MISMATCH', 'Ticket ID must match its filename.');
    if (ticket.workspace_id !== this.workspaceId) fail('WORKSPACE_CHANGED', 'Ticket belongs to a different folder. Copy the current workspace_id.');
    return ticket;
  }
  bindings(ticket) {
    let bytes = 0;
    return ticket.inputs.map(input => {
      const content = readBounded(this.root, input, LIMITS.inputBytes - bytes); bytes += content.length;
      return { path: input, sha256: digest(content) };
    });
  }
  review(ticket) {
    const inputs = this.bindings(ticket);
    const manifestDigest = digest(JSON.stringify(ticket));
    return { ticket, manifest_digest: manifestDigest, review_digest: digest(JSON.stringify({
      workspace_id: this.workspaceId, manifest_digest: manifestDigest, inputs })), inputs,
      checks_only: [...ticket.steps, ...ticket.verification].every(step => step.kind === 'check') };
  }
  scan() {
    this.assertRoot(); this.errors = [];
    let names;
    try { names = fs.readdirSync(safePath(this.root, `${BASE}/inbox`)).filter(n => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(n)).sort(); }
    catch (e) { if (e.code === 'ENOENT') return { pending: [], backlog: 0, scan_truncated: false }; throw e; }
    let bytes = 0; const pending = []; let processed = 0; let backlog = 0;
    for (const name of names.slice(0, LIMITS.scanFiles)) {
      if (bytes >= LIMITS.scanBytes) break;
      processed++;
      try {
        const maximum = Math.min(LIMITS.ticketBytes, LIMITS.scanBytes - bytes);
        const file = safePath(this.root, `${BASE}/inbox/${name}`);
        bytes += Math.min(fs.lstatSync(file).size, maximum);
        const ticket = this.readTicket(name, maximum);
        const key = `${ticket.id}.r${ticket.revision}`;
        const existing = this.records.get(key);
        if (existing) {
          if (existing.manifest_digest !== digest(JSON.stringify(ticket))) this.errors.push({ file: name, message: 'This revision was already decided. Increment revision before changing its contents.' });
          continue;
        }
        if ([...this.records.values()].some(r => r.id === ticket.id && r.revision > ticket.revision)) fail('STALE_REVISION', 'A newer revision of this ID already exists.');
        if (pending.length < LIMITS.buffer) pending.push(this.review(ticket));
        else backlog++;
      } catch (e) { this.errors.push({ file: name, message: redact(e.message).slice(0, 2000) }); }
    }
    return { pending, backlog, scan_truncated: processed < names.length };
  }
  snapshot() {
    const scanned = this.scan();
    if (this.policy && (Date.now() >= this.policy.expires_at || this.policy.remaining <= 0)) this.policy = null;
    return { workspace_id: this.workspaceId, workspace: this.root, ...scanned, errors: this.errors.slice(0, 10),
      active: this.active?.receipt ?? null, queued: this.queue.map(item => item.receipt),
      history: [...this.records.values()].filter(r => TERMINAL.has(r.status)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20).map(r => ({
        id: r.id, revision: r.revision, title: r.title, attempt_id: r.attempt_id, status: r.status,
        verification_status: r.verification_status, updated_at: r.updated_at, error: r.error, export_error: r.export_error })),
      paused: this.paused, policy: this.policy, last_error: this.lastError, cleanup_blocked: this.cleanupBlocked,
      limits: { buffer: LIMITS.buffer, steps: LIMITS.steps }, template: vehicleTemplate(this.workspaceId) };
  }
  exportReceipt(receipt, ticket) {
    const dir = `${BASE}/reports/${receipt.id}/${receipt.attempt_id}`;
    try {
      if (ticket) jsonWrite(this.root, `${dir}/ticket.json`, ticket);
      jsonWrite(this.root, `${dir}/RESULT.json`, receipt);
      const steps = (receipt.steps ?? []).map(step => `- ${step.phase}/${step.id}: ${step.status}${step.exit_code != null ? ` (exit ${step.exit_code})` : ''}${step.error ? `: ${step.error}` : ''}`).join('\n');
      writeAtomic(this.root, `${dir}/SUMMARY.md`, `# ${receipt.title}\n\nTicket: ${receipt.id} / revision ${receipt.revision}\nAttempt: ${receipt.attempt_id}\nStatus: ${receipt.status}\nVerification: ${receipt.verification_status}\n\n${receipt.error ?? ''}\n\n${steps}\n\nExported receipt; desktop private record is authoritative. Script execution is not sandboxed.\n`);
    } catch (e) { receipt.export_error = redact(e.message); this.lastError = `Report export failed: ${receipt.export_error}`; }
  }
  recordSummary(receipt) {
    const { steps, inputs, ...summary } = receipt;
    return summary;
  }
  save(receipt, ticket) {
    receipt.updated_at = now();
    jsonWrite(this.store, `${receipt.id}.r${receipt.revision}.json`, receipt);
    this.records.set(`${receipt.id}.r${receipt.revision}`, this.recordSummary(receipt));
    this.exportReceipt(receipt, ticket);
    if (receipt.export_error) jsonWrite(this.store, `${receipt.id}.r${receipt.revision}.json`, receipt);
    this.records.set(`${receipt.id}.r${receipt.revision}`, this.recordSummary(receipt));
  }
  approve(selections, source = 'local_user') {
    if (this.closed || this.paused) fail('PAUSED', 'The queue is paused. Resume it before approving.');
    if (this.cleanupBlocked) fail('CLEANUP_BLOCKED', 'Process cleanup was not confirmed. Close Secret Tunnel before authorizing further work.');
    array(selections, 1, LIMITS.buffer, 'Approval batch');
    if (this.records.size + selections.length > LIMITS.historyRecords) fail('HISTORY_FULL', 'Private history is full. An archive migration is required; old decisions must not be discarded.');
    if (this.queue.length + (this.active ? 1 : 0) + selections.length > LIMITS.buffer) fail('BUFFER_FULL', 'At most five approved packs can be outstanding.');
    const pending = this.scan().pending;
    const selected = selections.map(selection => {
      keys(selection, ['id', 'revision', 'review_digest'], 'approval');
      const view = pending.find(v => v.ticket.id === selection.id && v.ticket.revision === selection.revision);
      if (!view || view.review_digest !== selection.review_digest) fail('STALE_APPROVAL', 'The reviewed ticket or its inputs changed. Refresh and review again.');
      if (source === 'checks_policy' && !view.checks_only) fail('POLICY_BLOCKED', 'Automatic approval cannot run executable code.');
      return view;
    });
    if (new Set(selected.map(v => v.ticket.id)).size !== selected.length) fail('DUPLICATE_APPROVAL', 'Duplicate ticket selection.');
    const batchKeys = new Set(selected.map(v => `${v.ticket.id}.r${v.ticket.revision}`));
    const ordered = [];
    while (ordered.length < selected.length) {
      const next = selected.find(view => !ordered.includes(view) && (view.ticket.depends_on ?? []).every(dep => {
        const key = `${dep.id}.r${dep.revision}`;
        if (batchKeys.has(key)) return ordered.some(v => `${v.ticket.id}.r${v.ticket.revision}` === key);
        return this.records.get(key)?.status === 'succeeded';
      }));
      if (!next) fail('DEPENDENCY_BLOCKED', 'Dependencies are missing, failed, or cyclic. Include prerequisites in this batch or finish them first.');
      ordered.push(next);
    }
    const items = ordered.map(view => ({ ...view, receipt: {
      schema_version: 1, workspace_id: this.workspaceId, id: view.ticket.id, revision: view.ticket.revision,
      title: view.ticket.title, attempt_id: `attempt-${randomUUID()}`, manifest_digest: view.manifest_digest,
      review_digest: view.review_digest, inputs: view.inputs, approval_source: source, approved_at: now(),
      status: 'approved', verification_status: 'not_run', steps: [], updated_at: now(),
      containment: 'not_sandboxed', cleanup: process.platform === 'win32' ? 'desktop_job_on_shutdown; per_step_best_effort' : 'process_group',
    } }));
    try {
      for (const item of items) {
        jsonWrite(this.store, `${item.receipt.attempt_id}/ticket.json`, item.ticket);
        this.save(item.receipt, item.ticket);
        if (item.receipt.export_error) fail('REPORT_UNAVAILABLE', 'Cannot establish report directory; no action was started.');
      }
    } catch (e) {
      for (const item of items) { item.receipt.status = 'blocked'; item.receipt.error = redact(e.message); try { this.save(item.receipt); } catch {} }
      throw e;
    }
    this.queue.push(...items);
    void this.pump();
    return { accepted: items.map(i => ({ id: i.ticket.id, revision: i.ticket.revision, attempt_id: i.receipt.attempt_id })) };
  }
  reject(selection) {
    if (this.records.size >= LIMITS.historyRecords) fail('HISTORY_FULL', 'Private history is full. An archive migration is required.');
    keys(selection, ['id', 'revision', 'review_digest'], 'rejection');
    const view = this.scan().pending.find(v => v.ticket.id === selection.id && v.ticket.revision === selection.revision);
    if (!view || view.review_digest !== selection.review_digest) fail('STALE_APPROVAL', 'Ticket changed; refresh first.');
    const receipt = { schema_version: 1, workspace_id: this.workspaceId, id: view.ticket.id, revision: view.ticket.revision,
      title: view.ticket.title, attempt_id: `decision-${randomUUID()}`, manifest_digest: view.manifest_digest,
      status: 'rejected', verification_status: 'not_run', updated_at: now(), steps: [] };
    this.save(receipt, view.ticket); return { rejected: view.ticket.id };
  }
  detail(id, revision) {
    if ((typeof id !== 'string' || !ID.test(id)) || !Number.isSafeInteger(revision)) fail('INVALID_REQUEST', 'Invalid receipt identity.');
    const receipt = this.records.get(`${id}.r${revision}`);
    if (!receipt) fail('NOT_FOUND', 'No private receipt exists for this revision.');
    return JSON.parse(readBounded(this.store, `${id}.r${revision}.json`, LIMITS.receiptBytes).toString('utf8'));
  }
  setPolicy(enabled) {
    if (typeof enabled !== 'boolean') fail('INVALID_REQUEST', 'enabled must be boolean.');
    this.policy = enabled ? { kind: 'checks_only', remaining: 5, expires_at: Date.now() + LIMITS.policyMs } : null;
    if (enabled && (this.paused || this.cleanupBlocked)) { this.policy = null; fail('PAUSED', 'Resume the queue explicitly before enabling automatic checks.'); }
    return { policy: this.policy };
  }
  async tick() {
    if (!this.policy || this.paused || this.active || this.queue.length || this.closed) return;
    if (this.policy.expires_at <= Date.now() || this.policy.remaining <= 0) { this.policy = null; return; }
    const views = this.scan().pending.filter(v => v.checks_only && (v.ticket.depends_on ?? []).every(dep => this.records.get(`${dep.id}.r${dep.revision}`)?.status === 'succeeded')).slice(0, this.policy.remaining);
    if (!views.length) return;
    const selection = views.map(v => ({ id: v.ticket.id, revision: v.ticket.revision, review_digest: v.review_digest }));
    this.policy.remaining -= selection.length;
    this.approve(selection, 'checks_policy');
  }
  pause() { this.paused = true; this.policy = null; return { paused: true }; }
  resume() {
    if (this.closed || this.cleanupBlocked) fail('CLEANUP_BLOCKED', 'This runner cannot resume. Close Secret Tunnel and reconcile outstanding processes.');
    this.paused = false; void this.pump(); return { paused: false };
  }
  async cancel() {
    this.pause();
    for (const item of this.queue.splice(0)) {
      item.receipt.status = 'canceled'; item.receipt.finished_at = now(); item.receipt.error = 'Canceled before execution.';
      try { this.save(item.receipt); } catch (e) { this.lastError = `Cancellation receipt failed: ${redact(e.message)}`; }
    }
    if (this.active) {
      this.active.canceled = true;
      if (this.active.stop) this.active.stop();
    }
    return { cancel_requested: true };
  }
  async close() {
    this.closed = true; await this.cancel();
    for (let i = 0; this.active && i < 120; i++) await new Promise(resolve => setTimeout(resolve, 50));
    return { stopped: this.active === null };
  }
  async pump() {
    if (this.active || this.paused || this.closed || !this.queue.length) return;
    const item = this.queue.shift(); this.active = item;
    try { await this.execute(item); }
    catch (e) {
      item.receipt.status = item.started ? 'interrupted' : 'blocked'; item.receipt.error = redact(e.message); item.receipt.finished_at = now();
      this.lastError = item.receipt.error;
      try { this.save(item.receipt); } catch {}
    } finally {
      const success = item.receipt.status === 'succeeded';
      this.active = null;
      if (!success) this.pause();
      else setImmediate(() => { void this.pump(); });
    }
  }
  async execute(item) {
    const { ticket, receipt } = item;
    this.assertRoot();
    const current = this.review(this.readTicket(`${ticket.id}.json`));
    if (current.review_digest !== item.review_digest) {
      receipt.status = 'stale'; receipt.error = 'Approved contents or declared inputs changed before execution.'; receipt.finished_at = now(); this.save(receipt); return;
    }
    for (const dep of ticket.depends_on ?? []) {
      if (this.records.get(`${dep.id}.r${dep.revision}`)?.status !== 'succeeded') {
        receipt.status = 'blocked'; receipt.error = 'A prerequisite pack has not succeeded.'; this.save(receipt); return;
      }
    }
    item.started = Date.now(); item.deadline = item.started + (ticket.timeout_ms ?? 900000);
    item.stdout = ''; item.stderr = ''; item.events = [];
    receipt.status = 'running'; receipt.started_at = now(); this.save(receipt);
    for (const [phase, steps] of [['execution', ticket.steps], ['verification', ticket.verification]]) {
      if (phase === 'verification') { receipt.status = 'verifying'; receipt.verification_status = 'running'; this.save(receipt); }
      for (const step of steps) {
        if (item.canceled || Date.now() >= item.deadline) {
          receipt.status = item.canceled ? 'canceled' : 'timed_out'; receipt.error = 'Stopped before the next step.'; break;
        }
        this.assertRoot();
        const result = { id: step.id, title: step.title, phase, status: 'running', started_at: now() };
        receipt.steps.push(result); this.event(item, 'step_started', step.id); this.save(receipt);
        try {
          if (step.kind === 'check') {
            const check = checkFile(this.root, step); result.observation = check.observation;
            result.status = check.passed ? 'passed' : 'failed';
          } else Object.assign(result, await this.runProcess(item, step));
        } catch (e) { result.status = 'failed'; result.error = redact(e.message); }
        result.finished_at = now(); this.event(item, 'step_finished', `${step.id}: ${result.status}`); this.save(receipt);
        if (result.status !== 'passed' || receipt.export_error) {
          receipt.status = item.canceled ? 'canceled' : result.status === 'timed_out' ? 'timed_out' : phase === 'verification' ? 'verification_failed' : 'failed';
          receipt.error = result.error ?? (receipt.export_error ? 'Report export failed; stopped before more work.' : `Step ${step.id} did not pass.`);
          if (phase === 'verification') receipt.verification_status = 'failed';
          break;
        }
      }
      if (TERMINAL.has(receipt.status)) break;
      if (phase === 'verification') { receipt.verification_status = 'passed'; receipt.status = 'succeeded'; }
    }
    if (receipt.verification_status === 'running') receipt.verification_status = 'failed';
    receipt.finished_at = now(); receipt.duration_ms = Date.now() - item.started;
    this.flushLogs(item);
    if (receipt.export_error && receipt.status === 'succeeded') { receipt.status = 'failed'; receipt.error = 'Work completed, but report export failed. Do not replay without inspecting private evidence.'; }
    this.event(item, 'finished', receipt.status); this.save(receipt);
  }
  event(item, type, message) {
    item.events.push({ at: now(), type, message: redact(message) });
    const lines = item.events.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeAtomic(this.store, `${item.receipt.attempt_id}/events.jsonl`, lines);
    try { writeAtomic(this.root, `${BASE}/reports/${item.receipt.id}/${item.receipt.attempt_id}/events.jsonl`, lines); }
    catch (e) { item.receipt.export_error = redact(e.message); }
  }
  flushLogs(item) {
    for (const stream of ['stdout', 'stderr']) {
      const content = redact(item[stream] ?? '');
      writeAtomic(this.store, `${item.receipt.attempt_id}/${stream}.log`, content);
      try { writeAtomic(this.root, `${BASE}/reports/${item.receipt.id}/${item.receipt.attempt_id}/${stream}.log`, content); }
      catch (e) { item.receipt.export_error = redact(e.message); }
    }
  }
  async runProcess(item, step) {
    const cwd = safePath(this.root, step.cwd ?? '.');
    if (!fs.statSync(cwd).isDirectory()) fail('INVALID_CWD', 'Working directory is not a directory.');
    let program; let args; let raw = false;
    if (step.kind === 'command') {
      program = executable(step.program, this.root, cwd); args = step.args;
      if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(program)) fail('BATCH_REQUIRES_SCRIPT', 'Use a cmd script step (call npm.cmd ...), not command arguments for a batch file.');
    } else {
      const extension = { node: 'mjs', cmd: 'cmd', sh: 'sh', powershell: 'ps1' }[step.interpreter];
      const rel = `${item.receipt.attempt_id}/${step.id}.${extension}`;
      writeAtomic(this.store, rel, step.interpreter === 'powershell' ? '\ufeff' + step.body : step.body);
      const script = safePath(this.store, rel);
      if (step.interpreter === 'node') { program = process.execPath; args = [script]; }
      else if (step.interpreter === 'cmd') {
        if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED', 'cmd scripts require Windows.');
        const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
        program = path.join(system, 'System32', 'cmd.exe');
        if (/["%!\r\n]/.test(script)) fail('UNSAFE_SCRIPT_PATH', 'Profile path cannot be safely passed to cmd.exe.');
        args = ['/d', '/s', '/v:off', '/c', `""${script}""`]; raw = true;
      } else if (step.interpreter === 'powershell') {
        if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED', 'Use node or sh for a portable script.');
        const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
        program = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script];
      } else {
        if (process.platform === 'win32') fail('PLATFORM_UNSUPPORTED', 'sh scripts require macOS or Linux.');
        program = '/bin/sh'; args = [script];
      }
    }
    const timeout = Math.min(step.timeout_ms ?? 120000, item.deadline - Date.now());
    if (timeout <= 0) return { status: 'timed_out', exit_code: null, error: 'Pack deadline reached.' };
    return new Promise(resolve => {
      let child; let settled = false; let timedOut = false; let forcedTimer;
      let stdout = ''; let stderr = ''; let outputTruncated = false;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      for (const name of ['stdout', 'stderr']) item[name] = `${item[name]}\n[${step.id}]\n`;
      const finish = result => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forcedTimer); clearInterval(flushTimer);
        item.child = null; item.stop = null;
        if (child?.stdout) child.stdout.destroy(); if (child?.stderr) child.stderr.destroy();
        if (process.platform !== 'win32' && child?.pid) void killTree(child);
        try { this.flushLogs(item); } catch (e) { result = { ...result, status: 'failed', error: redact(e.message) }; }
        resolve({ ...result, stdout_tail: redact(stdout).slice(-512), stderr_tail: redact(stderr).slice(-512),
          output_truncated: outputTruncated, executed_program: program.slice(0, 1024) });
      };
      let timer; let flushTimer;
      try {
        child = spawn(program, args, { cwd, env: { ...safeEnvironment(), ST_ACTION_ID: item.ticket.id,
          ST_ACTION_ATTEMPT: item.receipt.attempt_id, ST_ACTION_WORKSPACE: this.root },
          shell: false, windowsHide: true, windowsVerbatimArguments: raw, detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'] });
        item.child = child;
      } catch (e) { finish({ status: 'failed', exit_code: null, error: redact(e.message) }); return; }
      const append = (name, buffer) => {
        const chunk = decoders[name].write(buffer);
        const aggregate = item[name] + chunk;
        if (aggregate.length > LIMITS.logBytes / 4) outputTruncated = true;
        item[name] = aggregate.slice(-LIMITS.logBytes / 4);
        if (name === 'stdout') { stdout += chunk; if (stdout.length > LIMITS.logBytes) { stdout = stdout.slice(-LIMITS.logBytes / 4); outputTruncated = true; } }
        else { stderr += chunk; if (stderr.length > LIMITS.logBytes) { stderr = stderr.slice(-LIMITS.logBytes / 4); outputTruncated = true; } }
      };
      child.stdout.on('data', data => append('stdout', data)); child.stderr.on('data', data => append('stderr', data));
      child.on('error', e => finish({ status: 'failed', exit_code: null, error: redact(e.message) }));
      child.on('close', (code, signal) => finish({ status: item.canceled ? 'canceled' : timedOut ? 'timed_out' : code === 0 ? 'passed' : 'failed', exit_code: code, signal }));
      flushTimer = setInterval(() => { try { this.flushLogs(item); } catch (e) { this.lastError = redact(e.message); } }, 1000);
      item.stop = () => {
        void killTree(child);
        if (!forcedTimer) forcedTimer = setTimeout(() => {
          this.cleanupBlocked = true; this.pause();
          this.lastError = 'Process cleanup could not be confirmed. Close Secret Tunnel before further execution.';
          finish({ status: item.canceled ? 'canceled' : 'timed_out', exit_code: null, error: this.lastError });
        }, 5500);
      };
      timer = setTimeout(() => { timedOut = true; item.stop?.(); }, timeout);
    });
  }
}

async function worker() {
  let controller; let inflight = Promise.resolve(); let carry = '';
  const timer = setInterval(() => {
    inflight = inflight.then(() => controller?.tick()).catch(e => { if (controller) controller.lastError = redact(e.message); });
  }, 2000);
  const dispatch = async request => {
    const { method, params = {} } = request;
    if (method === 'init' && !controller) {
      controller = new ActionsController(params.workspace, params.private_root);
      return { workspace_id: controller.workspaceId };
    }
    if (!controller) fail('NOT_INITIALIZED', 'Worker is not initialized.');
    switch (method) {
      case 'list': return controller.snapshot();
      case 'initialize': return controller.initialize();
      case 'detail': return controller.detail(params.id, params.revision);
      case 'approve': return controller.approve(params.selections);
      case 'reject': return controller.reject(params.selection);
      case 'pause': return controller.pause();
      case 'resume': return controller.resume();
      case 'cancel': return controller.cancel();
      case 'auto_checks': return controller.setPolicy(params.enabled);
      case 'prepare_switch':
        if (controller.active || controller.queue.length || controller.cleanupBlocked) fail('ACTIONS_BUSY', 'Finish or cancel approved actions before changing folders or access mode.');
        controller.pause(); return { ready: true };
      case 'shutdown': { clearInterval(timer); const result = await controller.close(); setImmediate(() => process.exit(result.stopped ? 0 : 2)); return result; }
      default: fail('INVALID_REQUEST', 'Unknown local action operation.');
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    carry += chunk;
    if (Buffer.byteLength(carry) > LIMITS.ticketBytes * 2) process.exit(3);
    let newline;
    while ((newline = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, newline); carry = carry.slice(newline + 1);
      inflight = inflight.then(async () => {
        let request;
        try { request = JSON.parse(line); const result = await dispatch(request); process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n'); }
        catch (e) { process.stdout.write(JSON.stringify({ id: request?.id ?? null, ok: false, error: { code: e.code ?? 'ACTION_ERROR', message: redact(e.message) } }) + '\n'); }
      });
    }
  });
  const stop = async () => { clearInterval(timer); await controller?.close(); process.exit(0); };
  process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
if (process.argv.includes('--worker') && import.meta.url === pathToFileURL(process.argv[1]).href) {
  worker().catch(() => process.exit(1));
}
