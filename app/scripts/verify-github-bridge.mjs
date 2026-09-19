import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = [
  'vendor/gpt-repo-mcp/src/github-bridge.ts',
  'vendor/gpt-repo-mcp/src/github-broker-client.mjs',
  'vendor/gpt-repo-mcp/src/github-broker-client.d.mts',
  'vendor/gpt-repo-mcp/src/github-contract.mjs',
  'vendor/gpt-repo-mcp/src/github-contract.d.mts',
  'scripts/github-bridge-tests/hardening.test.mjs',
  'scripts/github-bridge-tests/fixtures.mjs',
  'scripts/github-bridge-tests/client.test.mjs',
  'scripts/github-bridge-tests/sdk.test.mjs',
  'scripts/github-bridge-tests/website-workflow.test.mjs',
  'scripts/github-bridge-tests/rebind.test.mjs',
  'scripts/verify-github-bridge.mjs',
  'scripts/verify-github-bridge.cmd'
];
const help = `Secret Tunnel GitHub bridge verification

From repository root:
  node app/scripts/verify-github-bridge.mjs
  node app/scripts/verify-github-bridge.mjs --sdk
  node app/scripts/verify-github-bridge.mjs --report-dir <directory> [--sdk]

Default: fixed dependency-free client/handler tests against disposable loopback
mock brokers. --sdk additionally requires the real installed vendored TypeScript,
zod and MCP SDK, with type checking and tools/list/tools/call tests. Missing SDK
dependencies are a failing gate, never silently substituted with mocks.

A fresh nonoverwriting report directory contains report.json, TAP, stderr and
source hashes. No GitHub login, Git commands, actual broker, push or deployment.
Exit 0: requested tests passed (default mode does not claim SDK verification).
Exit 1: a requested test/gate failed. Exit 2: invalid input, drift or harness error.
`;
function argumentsFor(values) {
  const result = { sdk: false, reportRoot: tmpdir(), help: false };
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--sdk' && !result.sdk) result.sdk = true;
    else if (values[i] === '--help' || values[i] === '-h') result.help = true;
    else if (values[i] === '--report-dir' && i + 1 < values.length && !values[i + 1].startsWith('--')) {
      result.reportRoot = resolve(values[++i]);
    } else throw new Error('Unknown argument or missing --report-dir value. Use --help.');
  }
  return result;
}
async function hashes() {
  return Object.fromEntries(await Promise.all(inventory.map(async path => {
    let bytes;
    try { bytes = await readFile(join(appRoot, path)); }
    catch { throw new Error(`Verification input missing or unreadable: ${path}. Check the reviewed verification package; no passing result can be produced.`); }
    return [path, createHash('sha256').update(bytes).digest('hex')];
  })));
}
function cleanEnvironment(sdk, home) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, NO_COLOR: '1', SECRET_TUNNEL_VERIFY_SDK: sdk ? '1' : '0' };
}
function run(env) {
  return new Promise(resolveRun => {
    const args = ['--test', '--experimental-test-isolation=none', '--test-reporter=tap', '--test-concurrency=1',
      join(appRoot, 'scripts/github-bridge-tests/client.test.mjs'),
      join(appRoot, 'scripts/github-bridge-tests/hardening.test.mjs'),
      join(appRoot, 'scripts/github-bridge-tests/sdk.test.mjs'),
      join(appRoot, 'scripts/github-bridge-tests/website-workflow.test.mjs'),
      join(appRoot, 'scripts/github-bridge-tests/rebind.test.mjs')];
    const child = spawn(process.execPath, args, { cwd: appRoot, env, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] }; const sizes = { stdout: 0, stderr: 0 };
    let failed = null; let done = false; let exit = null; let signal = null;
    const complete = () => {
      if (done) return; done = true; clearTimeout(deadline); clearTimeout(reapDeadline);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolveRun({ exit_code: exit, signal, harness_failure: failed,
        stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    };
    let reapDeadline;
    const terminate = reason => {
      if (failed !== null) return;
      failed = reason; child.kill('SIGKILL');
      reapDeadline = setTimeout(complete, 3000);
    };
    const deadline = setTimeout(() => terminate('test_deadline_exceeded'), 120000);
    for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => {
      const available = Math.max(0, 4 * 1024 * 1024 - sizes[key]);
      output[key].push(chunk.subarray(0, available)); sizes[key] += chunk.length;
      if (sizes[key] > 4 * 1024 * 1024) terminate('test_output_limit');
    });
    child.on('error', () => { failed = 'test_process_start_failed'; complete(); });
    child.on('exit', (code, why) => { exit = code; signal = why; });
    child.on('close', complete);
  });
}
function counts(tap) {
  const count = name => {
    const match = new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm');
    const all = [...tap.matchAll(match)]; return all.length ? Number(all.at(-1)[1]) : null;
  };
  return { total: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), canceled: count('cancelled') };
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const start = new Date().toISOString();
  const before = await hashes();
  await mkdir(options.reportRoot, { recursive: true });
  const reportDir = await mkdtemp(join(options.reportRoot, 'secret-tunnel-github-bridge-'));
  const home = join(reportDir, 'isolated-home'); await mkdir(home);
  const runResult = await run(cleanEnvironment(options.sdk, home));
  const after = await hashes();
  const drift = inventory.filter(path => before[path] !== after[path]);
  const totals = counts(runResult.stdout);
  const basic = runResult.exit_code === 0 && runResult.harness_failure === null && drift.length === 0
    && totals.passed > 0 && totals.failed === 0 && totals.canceled === 0;
  const sdkBlocked = options.sdk && runResult.stdout.includes('SDK_GATE_BLOCKED');
  const success = basic && (!options.sdk || totals.skipped === 0);
  const report = {
    schema_version: 1, component: 'secret-tunnel-github-mcp-bridge', started_at: start, finished_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    origin: 'executed_local_tests_with_mock_broker', result: success ? 'passed' : 'failed',
    requested_profile: options.sdk ? 'client_and_real_sdk' : 'client_only',
    sdk_gate: options.sdk ? (sdkBlocked ? 'blocked_missing_dependencies' : success ? 'passed' : 'failed') : 'not_requested',
    application_end_to_end: 'not_run', native_windows: process.platform === 'win32' ? 'client_suite_only' : 'not_run',
    github_login_push_pages: 'not_run', totals, process_exit_code: runResult.exit_code, signal: runResult.signal,
    harness_failure: runResult.harness_failure, source_drift: drift, source_sha256_before: before, source_sha256_after: after,
    artifacts: { report: 'report.json', tap: 'tests.tap', stderr: 'stderr.log' },
    limitations: ['Tests do not authenticate, run Git, contact GitHub or call the production Rust broker.',
      'Native Rust/Tauri, packaged MCP bundle and actual ChatGPT tests remain separate gates.',
      'Runner is for these fixed trusted tests only, not a sandbox for arbitrary project scripts.']
  };
  await writeFile(join(reportDir, 'tests.tap'), runResult.stdout, { flag: 'wx' });
  await writeFile(join(reportDir, 'stderr.log'), runResult.stderr, { flag: 'wx' });
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, report_directory: reportDir }, null, 2));
  process.exitCode = success ? 0 : (runResult.harness_failure || drift.length ? 2 : 1);
}
main().catch(error => { console.error(JSON.stringify({ result: 'harness_error', message: error.message })); process.exitCode = 2; });
