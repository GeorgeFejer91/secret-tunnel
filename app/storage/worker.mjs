/** Private, one-shot SFTP worker. Requests arrive on stdin from the desktop.
 * No shell commands, inherited rclone configuration, public listener or sync. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEXT_LIMIT = 128 * 1024;
export class StorageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new StorageError(code, message); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function relativePath(value, allowRoot = false) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\:\x00-\x1f\x7f]/u.test(value) || value.startsWith('/'))
    fail('invalid_path', 'Use a relative path with forward slashes.');
  if (allowRoot && (value === '' || value === '.')) return '';
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('-') || /[. ]$/u.test(p)))
    fail('invalid_path', 'Empty, parent, option-like and ambiguous path components are not supported.');
  if (parts.some(p => /^(\.git|\.ssh|\.aws|\.gnupg|\.secret-tunnel.*|\.env(?:\..*)?)$/iu.test(p) || /\.(pem|key)$/iu.test(p)))
    fail('denied_path', 'Credential and internal paths are not exposed.');
  return value;
}
export function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/u.test(value)) fail('invalid_request_id', 'Use a unique operation identifier of 8–80 letters, digits, hyphens or underscores.');
  return value;
}
export function checkConfig(c) {
  if (!c || !/^u\d+\.your-storagebox\.de$/u.test(c.host) || !/^u\d+(?:-sub\d+)?$/u.test(c.user)
      || c.user.split('-')[0] !== c.host.split('.')[0] || ![22,23].includes(c.port))
    fail('invalid_connection', 'Use a matching Hetzner hostname/account and SSH port 22 or 23.');
  if (!path.isAbsolute(c.rclonePath || '') || !path.isAbsolute(c.knownHostsPath || '') || /\.(cmd|bat|ps1)$/iu.test(c.rclonePath))
    fail('invalid_runtime', 'Select the native rclone executable and a verified known_hosts file.');
  if ((!c.password) === (!c.keyPath) || (c.keyPath && !path.isAbsolute(c.keyPath)) || (c.password && (c.password.length > 4096 || /[\r\n\0]/u.test(c.password))))
    fail('invalid_authentication', 'Choose either password authentication or an absolute private-key path.');
}
export function cleanEnvironment(parent = process.env) {
  const result = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG']) if (parent[key]) result[key] = parent[key];
  return result;
}
export function makeRunner(config, assertActive = async () => {}) {
  let env = cleanEnvironment(), stopped = false;
  const children = new Set();
  const stop = () => { stopped = true; for (const child of children) child.kill(); };
  async function run(args, { input, hash = false, limit = 8 * 1024 * 1024, timeout = 90000, bare = false } = {}) {
    if (stopped) fail('operation_cancelled', 'The storage worker stopped.');
    await assertActive();
    return new Promise((resolve, reject) => {
      const child = spawn(config.rclonePath, bare ? args : [...args, '--config', '', '--ask-password=false',
        '--retries','1','--low-level-retries','1','--contimeout','15s','--timeout','45s','--transfers','1','--checkers','1'],
        { shell: false, windowsHide: true, env, stdio: ['pipe','pipe','pipe'] });
      children.add(child);
      let count = 0, stderr = '', forced, settled = false;
      const chunks = [], sha = createHash('sha256');
      const abort = e => { forced ||= e; child.kill(); };
      const timer = setTimeout(() => abort(new StorageError('operation_timeout', 'The operation timed out. Check the receipt before retrying.')), timeout);
      const poll = setInterval(() => { void assertActive().catch(abort); }, 500);
      function finish(error, value) {
        if (settled) return; settled = true;
        clearTimeout(timer); clearInterval(poll); children.delete(child);
        if (error) reject(error); else resolve(value);
      }
      child.stdout.on('data', bytes => {
        count += bytes.length;
        if (hash) sha.update(bytes);
        else if (count > limit) abort(new StorageError('result_too_large', 'This response exceeds the bounded result limit. Choose a smaller directory or range.'));
        else chunks.push(bytes);
      });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-16384); });
      child.on('error', () => finish(new StorageError('rclone_unavailable', 'The configured native rclone executable could not start.')));
      child.on('close', code => {
        if (forced || stopped) return finish(forced || new StorageError('operation_cancelled','The storage worker stopped.'));
        if (code !== 0) {
          let name = 'storage_io', message = 'SFTP operation failed. Check the saved connection and operation receipt.';
          if (/knownhosts|host key|hostkey/iu.test(stderr)) { name = 'host_key_rejected'; message = 'SSH host verification failed. Verify the trusted hostname/port entry; do not disable verification.'; }
          else if (/authenticate|authentication|permission denied/iu.test(stderr)) { name = 'authentication_or_permission'; message = 'Authentication or remote permissions refused the operation.'; }
          else if ([3,4].includes(code)) { name = 'not_found'; message = 'The requested path does not exist.'; }
          return finish(new StorageError(name, message));
        }
        finish(null, hash ? { sha256: sha.digest('hex'), bytes: count } : Buffer.concat(chunks));
      });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  return { run, stop, async initialise() {
    checkConfig(config);
    for (const p of [config.rclonePath, config.knownHostsPath, config.keyPath].filter(Boolean)) {
      const st = await fs.lstat(p); if (!st.isFile() || st.isSymbolicLink()) fail('invalid_runtime', 'Executable, host-verification and key paths must be regular files.');
    }
    const pass = config.password ? (await run(['obscure','-'], { input: config.password, bare: true, limit: 8192, timeout: 10000 })).toString('utf8').trim() : '';
    env = { ...cleanEnvironment(), RCLONE_CONFIG_STBOX_TYPE: 'sftp', RCLONE_CONFIG_STBOX_HOST: config.host,
      RCLONE_CONFIG_STBOX_USER: config.user, RCLONE_CONFIG_STBOX_PORT: String(config.port),
      RCLONE_CONFIG_STBOX_KNOWN_HOSTS_FILE: config.knownHostsPath,
      RCLONE_CONFIG_STBOX_PASS: pass, RCLONE_CONFIG_STBOX_KEY_FILE: config.keyPath || '',
      RCLONE_CONFIG_STBOX_KEY_USE_AGENT: 'false', RCLONE_CONFIG_STBOX_SHELL_TYPE: 'none',
      RCLONE_CONFIG_STBOX_DISABLE_HASHCHECK: 'true', RCLONE_CONFIG_STBOX_SKIP_LINKS: 'true',
      // One more than transfers + checkers; two can deadlock rclone.
      RCLONE_CONFIG_STBOX_CONNECTIONS: '3' };
  } };
}
const remote = p => `stbox:${p}`;
const sameStat = (a,b) => a.Size === b.Size && a.ModTime === b.ModTime && a.IsDir === b.IsDir;
function json(buffer) { try { return JSON.parse(buffer.toString('utf8')); } catch { fail('invalid_backend_result', 'rclone returned invalid JSON.'); } }
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('invalid_limit','Invalid offset or limit.');
  return value;
}
function equalBytes(a,b) { if (a.sha256 !== b.sha256 || a.bytes !== b.bytes) fail('verification_failed','The destination content did not match. The original source was retained.'); }
export function globMatch(pattern, value) {
  if (typeof pattern !== 'string' || /[!\[\]{}\\]/u.test(pattern)) fail('local_policy_unsupported', 'This local root uses unsupported glob syntax. Use the existing local file tools.');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i,i+3) === '**/') { source += '(?:.*/)?'; i += 2; }
    else if (pattern.slice(i,i+2) === '**') { source += '.*'; i++; }
    else if (pattern[i] === '*') source += '[^/]*';
    else if (pattern[i] === '?') source += '[^/]';
    else source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'iu' : 'u').test(value);
}

export function createOperations(run, { assertActive = async () => {}, roots = [], protectedPaths = [] } = {}) {
  async function stat(p, optional = false) {
    try { return json(await run(['lsjson',remote(p),'--stat'])); }
    catch (e) { if (optional && e.code === 'not_found') return null; throw e; }
  }
  async function absent(p) { if (await stat(p,true)) fail('destination_exists','Choose a new destination; this path already exists.'); }
  async function shaRemote(p) { return run(['cat',remote(p)], { hash: true, timeout: 86400000 }); }
  async function full(p) {
    const before = await stat(p);
    if (before.IsDir || before.Size < 0 || before.Size > TEXT_LIMIT) fail('not_editable','Only complete UTF-8 files up to 128 KiB can be replaced.');
    const bytes = await run(['cat',remote(p)], {limit: TEXT_LIMIT});
    if (bytes.length !== before.Size || !sameStat(before, await stat(p))) fail('source_changed','The file changed while it was read.');
    return { bytes, sha256: digest(bytes) };
  }
  // Listing omits symlinks; verify existing components before direct operations.
  // This is a preflight, NOT a replacement for server-side account confinement.
  async function regularRemote(p, creating = false) {
    if (!p) return;
    const parts = p.split('/'); let parent = '';
    for (let i = 0; i < parts.length; i++) {
      const entries = json(await run(['lsjson',remote(parent)]));
      const entry = entries.find(e => e.Name === parts[i]);
      if (!entry) {
        if (creating && i === parts.length - 1) { await absent(p); return; }
        fail('unsafe_remote_path','The path is missing, linked or unsupported.');
      }
      if (i < parts.length - 1 && !entry.IsDir) fail('unsafe_remote_path','A parent is not a regular directory.');
      parent = parent ? `${parent}/${parts[i]}` : parts[i];
    }
  }
  async function local(p, rootId, writing = false) {
    p = relativePath(p);
    const root = roots.find(r => r.repo_id === rootId);
    if (!root || (writing && !root.writes?.enabled)) fail('local_root_denied','This local root is unavailable or read-only.');
    for (const g of root.writes?.denied_globs || []) if (globMatch(g,p)) fail('local_policy_denied','The local policy excludes this path.');
    if (root.writes?.allowed_globs?.length && !root.writes.allowed_globs.some(g => globMatch(g,p))) fail('local_policy_denied','The local policy does not allow this path.');
    const rootStat = await fs.lstat(root.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('unsafe_local_path','The selected local root is no longer an ordinary directory.');
    let current = await fs.realpath(root.root); const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current,parts[i]);
      try {
        const st = await fs.lstat(current);
        if (st.isSymbolicLink() || (i < parts.length-1 ? !st.isDirectory() : !st.isFile() || st.nlink > 1)) fail('unsafe_local_path','Only ordinary files through non-link directories are supported.');
      } catch (e) { if (!(writing && i === parts.length-1 && e.code === 'ENOENT')) throw e; }
    }
    const key = s => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s);
    for (const blocked of protectedPaths.filter(Boolean)) if (key(current) === key(blocked) || key(current).startsWith(key(blocked)+path.sep)) fail('protected_path','App state and credentials cannot be transferred.');
    return current;
  }
  async function shaLocal(p) {
    const handle = await fs.open(p,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes = 0; const sha = createHash('sha256');
    try { for await (const chunk of handle.createReadStream({autoClose:false})) { await assertActive(); bytes += chunk.length; sha.update(chunk); } }
    finally { await handle.close(); }
    return {sha256:sha.digest('hex'),bytes};
  }
  return {
    async test() {
      const version = (await run(['version'],{limit:8192})).toString('utf8').split('\n')[0];
      if (!(await stat('')).IsDir) fail('invalid_root','The account root is not a directory.');
      return {readable:true,writeTested:false,version,scope:'account_root'};
    },
    async list(input) {
      const p = relativePath(input.path ?? '',true), offset = integer(input.offset,0,1000000), limit = integer(input.limit,100,500) || 1;
      await regularRemote(p);
      const all = json(await run(['lsjson',remote(p)])); const entries = [];
      for (const e of all) {
        try { const name = relativePath(e.Name); if (name.includes('/')) continue;
          entries.push({name,path:p ? `${p}/${name}` : name,directory:!!e.IsDir,sizeBytes:e.Size,modified:e.ModTime});
        } catch { /* Denied/unsupported entries are deliberately not routable. */ }
      }
      entries.sort((a,b) => Number(b.directory)-Number(a.directory) || a.name.localeCompare(b.name,'en'));
      const snapshot = digest(Buffer.from(JSON.stringify(entries)));
      if (input.snapshot && input.snapshot !== snapshot) fail('listing_changed','The directory changed. Restart listing at offset zero.');
      return {path:p,entries:entries.slice(offset,offset+limit),snapshot,nextOffset:offset+limit < entries.length ? offset+limit : null,totalVisible:entries.length,omitted:all.length-entries.length};
    },
    async read(input) {
      const p = relativePath(input.path), offset = integer(input.offset,0,Number.MAX_SAFE_INTEGER), maxBytes = integer(input.maxBytes,64000,TEXT_LIMIT) || 1;
      await regularRemote(p);
      const before = await stat(p);
      if (before.IsDir || before.Size < 0 || offset > before.Size) fail('invalid_range','Select a regular file and a valid offset.');
      let bytes = await run(['cat',remote(p),'--offset',String(offset),'--count',String(maxBytes)],{limit:maxBytes});
      if (bytes.length !== Math.min(maxBytes,before.Size-offset) || !sameStat(before,await stat(p))) fail('source_changed','The file changed or a short read occurred.');
      const maxTrim = offset + bytes.length < before.Size ? 3 : 0; let text, trim = 0;
      for (; trim <= maxTrim && trim <= bytes.length; trim++) {
        try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytes.length-trim)); break; } catch { /* Incomplete trailing character only. */ }
      }
      if (text === undefined || text.includes('\0') || (bytes.length && bytes.length === trim)) fail('not_text','This is not a valid UTF-8 text range. Copy binary documents for format-aware processing.');
      bytes = bytes.subarray(0,bytes.length-trim);
      const complete = offset === 0 && bytes.length === before.Size;
      return {path:p,text,sizeBytes:before.Size,offset,bytesRead:bytes.length,contentComplete:complete,sha256:complete ? digest(bytes) : null,hashScope:complete ? 'whole_file' : null,nextOffset:offset+bytes.length < before.Size ? offset+bytes.length : null};
    },
    async write(input) {
      const p = relativePath(input.path), id = requestId(input.requestId), expected = input.expectedSha256;
      if (typeof input.content !== 'string' || input.content.includes('\0')) fail('invalid_text','Supply UTF-8 text without NUL characters.');
      const bytes = Buffer.from(input.content,'utf8');
      if (bytes.length > TEXT_LIMIT) fail('write_too_large','Text writes are limited to 128 KiB. Use file copy for larger files.');
      if (expected !== null && !/^[a-f0-9]{64}$/u.test(expected || '')) fail('precondition_required','Supply null for create-only or the whole-file SHA-256 from a complete read.');
      await regularRemote(p,true);
      async function precondition() {
        if (expected === null) await absent(p);
        else if (!(await stat(p,true)) || (await full(p)).sha256 !== expected) fail('write_conflict','The destination no longer matches the file originally read.');
      }
      await precondition();
      const parent = p.includes('/') ? p.slice(0,p.lastIndexOf('/')+1) : '';
      const staging = `${parent}.secret-tunnel-part-${id}`; await absent(staging);
      await run(['rcat',remote(staging),'--size',String(bytes.length)],{input:bytes,timeout:120000});
      const expectedBytes = {sha256:digest(bytes),bytes:bytes.length}; equalBytes(expectedBytes,await shaRemote(staging));
      await assertActive(); await regularRemote(p,true); await precondition();
      const backup = expected === null ? null : `.secret-tunnel-history/${id}`;
      await run(['moveto',remote(staging),remote(p),...(backup ? ['--ignore-times','--backup-dir',remote(backup)] : ['--immutable'])],{timeout:120000});
      equalBytes(expectedBytes,await shaRemote(p));
      return {path:p,...expectedBytes,verified:'sha256_readback',backupDirectory:backup,concurrency:'optimistic_precheck_not_atomic_cas'};
    },
    async copy(input) {
      const p = relativePath(input.remotePath), id = requestId(input.requestId), direction = input.direction;
      if (!['upload','download'].includes(direction)) fail('invalid_direction','Use upload or download.');
      const target = await local(input.localPath,input.repoId,direction === 'download'), timeout = 86400000;
      await regularRemote(p,direction === 'upload');
      if (direction === 'upload') {
        await absent(p); const original = await shaLocal(target);
        const parent = p.includes('/') ? p.slice(0,p.lastIndexOf('/')+1) : '', staging = `${parent}.secret-tunnel-part-${id}`;
        await absent(staging); await run(['copyto',target,remote(staging),'--immutable'],{timeout});
        equalBytes(original,await shaRemote(staging)); await assertActive(); await regularRemote(p,true); await absent(p);
        await run(['moveto',remote(staging),remote(p),'--immutable'],{timeout}); equalBytes(original,await shaRemote(p));
        return {path:p,...original,direction,verified:'sha256_readback',sourceRetained:true};
      }
      try { await fs.lstat(target); fail('destination_exists','The local destination already exists.'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      const before = await stat(p); if(before.IsDir) fail('not_file','Copy one regular file, not a directory.');
      const tempDir = await fs.mkdtemp(path.join(path.dirname(target),'.secret-tunnel-download-')), temp = path.join(tempDir,'payload');
      try {
        const original = await shaRemote(p); await run(['copyto',remote(p),temp,'--immutable'],{timeout}); equalBytes(original,await shaLocal(temp));
        if (!sameStat(before,await stat(p))) fail('source_changed','The remote source changed during copying.');
        await assertActive(); await local(input.localPath,input.repoId,true);
        await fs.link(temp,target); // Same filesystem, atomic no-clobber local creation.
        return {path:input.localPath,...original,direction,verified:'sha256_readback',sourceRetained:true};
      } finally { await fs.rm(tempDir,{recursive:true,force:true}); }
    },
  };
}
async function main() {
  let total = 0; const chunks = [];
  for await (const c of process.stdin) { total += c.length; if(total > 2*1024*1024) fail('request_limit','Worker request too large.'); chunks.push(c); }
  const packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const assertActive = async () => {
    if ((await fs.readFile(packet.grantFile,'utf8')).trim() !== packet.revision) fail('access_revoked','Storage access changed or was revoked. Inspect the receipt before retrying.');
    try { process.kill(packet.parentPid,0); } catch { fail('parent_stopped','The desktop application stopped.'); }
    if (packet.requireWrite) {
      const settings = JSON.parse(await fs.readFile(packet.settingsFile,'utf8'));
      if(settings.accessMode !== 'read_write') fail('access_revoked','Global write access was revoked.');
      if(packet.operation === 'copy') {
        const root = packet.roots.find(r => r.repo_id === packet.input.repoId);
        const selected = await Promise.all([settings.workspacePath,...(settings.extraFolders || [])].filter(Boolean).map(p => fs.realpath(p).catch(() => null)));
        const key = p => process.platform === 'win32' ? p?.toLowerCase().replace(/^\\\\\?\\/u,'') : p;
        if(!root || !selected.some(p => key(p) === key(root.root))) fail('access_revoked','The approved local folder changed.');
      }
    }
  };
  const runner = makeRunner(packet.config,assertActive);
  process.once('SIGTERM',runner.stop); process.once('SIGINT',runner.stop);
  try {
    await runner.initialise();
    const ops = createOperations(runner.run,{assertActive,roots:packet.roots,protectedPaths:packet.protectedPaths});
    if(!Object.hasOwn(ops,packet.operation)) fail('unknown_operation','Unsupported storage operation.');
    process.stdout.write(JSON.stringify({ok:true,value:await ops[packet.operation](packet.input || {})}));
  } finally { runner.stop(); }
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    process.stdout.write(JSON.stringify({ok:false,error:{code:e instanceof StorageError ? e.code : 'storage_failure',message:e instanceof StorageError ? e.message : 'Storage operation failed. Check the configuration and receipt.'}}));
    process.exitCode = 1;
  });
}
