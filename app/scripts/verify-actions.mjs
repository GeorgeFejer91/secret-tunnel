import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, killTree } from './action-vehicle.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const app = path.dirname(scripts);
const repo = path.dirname(app);
const sourceFiles = ['scripts/action-vehicle.mjs', 'scripts/action-vehicle.test.mjs', 'scripts/action-framework.test.mjs', 'scripts/action-ticket.mjs', 'scripts/verify-actions.mjs', 'src/actions.ts', 'src/actions.css', 'actions.html', 'src-tauri/src/actions.rs', 'src-tauri/capabilities/actions.json', 'src-tauri/src/lib.rs', 'src-tauri/src/commands.rs', 'src-tauri/src/settings.rs', 'vite.config.ts', 'package.json'];
function read(relative) { return fs.readFileSync(path.join(app, relative), 'utf8').replaceAll('\r\n', '\n'); }
function integrationChecks() {
  const rules = [
    ['actions module registered', 'src-tauri/src/lib.rs', /\bmod actions\s*;/],
    ['actions state managed', 'src-tauri/src/lib.rs', /\.manage\(actions::ActionsState::default\(\)\)/],
    ['desktop request registered', 'src-tauri/src/lib.rs', /actions::actions_request/],
    ['main-window-only shutdown', 'src-tauri/src/lib.rs', /window\.label\(\) == "main"/],
    ['main-window Actions button', 'index.html', /id="open-actions"/],
    ['main-window Actions invocation', 'src/main.ts', /invoke\("open_actions"\)/],
    ['multi-page build entry', 'vite.config.ts', /actions:\s*"actions\.html"/],
    ['embedded installed vehicle', 'src-tauri/src/actions.rs', /include_str!\("\.\.\/\.\.\/scripts\/action-vehicle\.mjs"\)/],
    ['local-window authorization check', 'src-tauri/src/actions.rs', /local_window\(&window, "actions"\)\?/],
    ['workspace change serialized', 'src-tauri/src/commands.rs', /crate::actions::change_settings/],
    ['report-write protection configured', 'src-tauri/src/settings.rs', /\.chatgpt\/actions\/reports\/\*\*/],
    ['remote operations remain disabled', 'src-tauri/src/settings.rs', /"operations":\s*\{\s*"enabled":\s*false/],
  ];
  return rules.map(([name, file, pattern]) => {
    try { return { name, layer: 'static_integration', status: pattern.test(read(file)) ? 'passed' : 'failed', file }; }
    catch (error) { return { name, layer: 'static_integration', status: 'failed', file, reason: error.message }; }
  });
}
function run(name, program, args, cwd, evidence, timeoutMs = 120000) {
  return new Promise(resolve => {
    let output = ''; let bytes = 0; let timedOut = false; let settled = false; let cleanupTimer;
    const started = Date.now();
    const child = spawn(program, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CARGO_TERM_COLOR: 'never', NO_COLOR: '1' } });
    const finish = (status, code, error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      child.stdout?.destroy(); child.stderr?.destroy();
      fs.writeFileSync(path.join(evidence, name + '.log'), redact(output));
      const stats = {};
      for (const field of ['tests', 'pass', 'fail', 'skipped']) {
        const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
        if (matches.length) stats[field] = Number(matches.at(-1)[1]);
      }
      resolve({ name, status, exit_code: code, duration_ms: Date.now() - started, timed_out: timedOut, error, log: name + '.log', output_truncated: bytes > 4194304, ...(Object.keys(stats).length ? { counts: stats } : {}) });
    };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      output = (output + chunk.toString('utf8')).slice(-4194304);
    });
    const timer = setTimeout(() => {
      timedOut = true; void killTree(child);
      cleanupTimer = setTimeout(() => finish('failed', null, 'Verification subprocess cleanup was not confirmed.'), 6000);
    }, timeoutMs);
    child.on('error', error => finish('blocked', null, redact(error.message)));
    child.on('close', code => finish(!timedOut && code === 0 ? 'passed' : 'failed', code));
  });
}
function npmInvocation() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const cli = candidates.find(p => fs.existsSync(p));
  if (!cli) throw new Error('npm CLI was not found beside Node. Run through npm run verify:actions -- --full.');
  return [process.execPath, [cli, 'run', 'build']];
}
export async function main(args) {
  if (args.some(arg => !['--core', '--full', '--runner-only', '--output', '--help'].includes(arg) && args[args.indexOf(arg) - 1] !== '--output')) throw new Error('Unknown argument. Use --core or --full, optionally --output DIRECTORY.');
  if (args.includes('--help')) { console.log('verify-actions.mjs [--core|--full|--runner-only] [--output NEW_DIRECTORY]\nCore: runner tests + static wiring. Runner-only: usable in the source bundle before integration. Full also runs frontend build and offline Cargo fmt/check/test. Does not install, publish, start the app, or connect a tunnel.'); return; }
  const supplied = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
  const out = path.resolve(supplied || path.join(repo, 'outputs/actions-verification', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid));
  if (fs.existsSync(out)) throw new Error('Evidence output must be a new directory.');
  fs.mkdirSync(out, { recursive: true });
  const checks = args.includes('--runner-only') ? [{ name: 'source-integration', status: 'not_run', reason: 'Runner-only mode does not establish repository integration.' }] : integrationChecks();
  checks.push(await run('runner-tests', process.execPath, ['--test', '--test-reporter=tap', path.join(scripts, 'action-vehicle.test.mjs'), path.join(scripts, 'action-framework.test.mjs')], app, out));
  if (args.includes('--full')) {
    try { const [program, command] = npmInvocation(); checks.push(await run('frontend-build', program, command, app, out, 300000)); }
    catch (error) { checks.push({ name: 'frontend-build', status: 'blocked', error: error.message }); }
    for (const [name, args] of [['rust-format', ['fmt', '--all', '--', '--check']], ['rust-check', ['check', '--locked', '--offline']], ['rust-tests', ['test', '--locked', '--offline']]]) checks.push(await run(name, 'cargo', args, path.join(app, 'src-tauri'), out, 300000));
  } else {
    checks.push({ name: 'frontend-and-native-build', status: 'not_run', reason: 'Use --full with the development toolchain and dependencies already installed.' });
  }
  checks.push({ name: 'native-desktop-acceptance', status: 'not_run', reason: 'Follow the isolated five-pack desktop walkthrough in For-AI/PROTOCOLS/action-verification.md. Browser mocks do not prove native IPC.' });
  const sources = {};
  for (const file of sourceFiles) { try { sources[file] = createHash('sha256').update(fs.readFileSync(path.join(app, file))).digest('hex'); } catch { sources[file] = null; } }
  const failed = checks.some(check => ['failed', 'blocked'].includes(check.status));
  const report = { schema_version: 1, created_at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, mode: args.includes('--full') ? 'full' : args.includes('--runner-only') ? 'runner-only' : 'core', status: failed ? 'failed_or_blocked' : args.includes('--runner-only') ? 'runner_tests_passed_integration_unverified' : 'automated_checks_passed_native_ui_unverified', checks, sources, limits: ['Static checks are wiring checks, not execution evidence.', 'Core tests use isolated temporary projects and exercise real child processes.', 'Windows-only tests may be skipped on other platforms.', 'Native GUI, installed runtime, process-tree behavior, and MCP denial tests need the documented native acceptance walkthrough.'] };
  fs.writeFileSync(path.join(out, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'SUMMARY.md'), `# Actions verification\n\n${report.status}\n\n` + checks.map(c => `- ${c.name}: ${c.status}${c.reason ? ' — ' + c.reason : ''}`).join('\n') + '\n');
  console.log(JSON.stringify({ status: report.status, report: path.join(out, 'RESULT.json'), checks: checks.map(({ name, status, counts }) => ({ name, status, counts })) }, null, 2));
  process.exitCode = failed ? 1 : 0;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
