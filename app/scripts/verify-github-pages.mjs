#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const files = ['github-pages/core.mjs', 'github-pages/http.mjs', 'github-pages/inspect.mjs', 'github-pages/core.test.mjs', 'verify-github-pages.mjs'];
const LIMIT = 1024 * 1024;
function childEnvironment() {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
}
async function hashes() {
  const result = {};
  for (const name of files) result[name] = createHash('sha256').update(await readFile(join(scriptDir, name))).digest('hex');
  return result;
}
function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const killer = spawn(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {stdio:'ignore', windowsHide:true, shell:false, env:childEnvironment()});
    killer.on('error', () => { try {child.kill();} catch {} });
  } else {
    try {process.kill(-child.pid, 'SIGKILL');} catch {try {child.kill('SIGKILL');} catch {}}
  }
}
function execute(args, timeoutMs) {
  return new Promise(resolveResult => {
    const started = performance.now();
    let out = '', err = '', outBytes = 0, errBytes = 0, truncated = false, done = false, timedOut = false, cleanup;
    const child = spawn(process.execPath, args, {cwd:scriptDir, shell:false, windowsHide:true, detached:process.platform !== 'win32', env:childEnvironment(), stdio:['ignore','pipe','pipe']});
    const timer = setTimeout(() => {
      timedOut = true; terminate(child);
      cleanup = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(null, 'CLEANUP_UNCONFIRMED'); }, 3000);
    }, timeoutMs);
    function finish(code, error) {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(cleanup);
      resolveResult({ args, exit_code:code, status:code===0 && !timedOut && !truncated && !error ? 'passed' : 'failed', timed_out:timedOut,
        output_truncated:truncated, duration_ms:Math.round(performance.now()-started), ...(error ? {error} : {}), stdout:out, stderr:err });
    }
    child.stdout.on('data', chunk => { if(outBytes+chunk.length<=LIMIT) out+=chunk.toString('utf8'); else truncated=true; outBytes+=chunk.length; });
    child.stderr.on('data', chunk => { if(errBytes+chunk.length<=LIMIT) err+=chunk.toString('utf8'); else truncated=true; errBytes+=chunk.length; });
    child.on('error', () => finish(null, 'SPAWN_FAILED'));
    child.on('close', code => finish(code));
  });
}
export async function verify() {
  const report = {schema_version:1, kind:'secret-tunnel.verification', suite:'github-pages', run_id:randomUUID(),
    started_at:new Date().toISOString(), runtime:{node:process.version, platform:process.platform, arch:process.arch},
    scope:'isolated deterministic verifier tests; not application, native credential, live GitHub, or Pages publication evidence', checks:[]};
  report.source_sha256 = await hashes();
  for (const name of files) {
    const result = await execute(['--check',join(scriptDir,name)], 15000);
    report.checks.push({name:`syntax:${name}`,...result});
  }
  if (report.checks.every(c=>c.status==='passed')) {
    const tests = await execute(['--test','--test-reporter=tap',join(scriptDir,'github-pages/core.test.mjs')], 120000);
    const number = label => Number(tests.stdout.match(new RegExp(`^# ${label} (\\d+)\\s*$`, 'm'))?.[1] ?? NaN);
    const summary = Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(key=>[key,number(key)]));
    const valid = Object.values(summary).every(Number.isSafeInteger) && summary.tests>0 && summary.fail===0 && summary.cancelled===0 && summary.todo===0 && summary.pass+summary.skipped===summary.tests;
    report.checks.push({name:'behavioral-tests',...tests,status:tests.status==='passed' && valid ? 'passed' : 'failed', summary});
  } else report.checks.push({name:'behavioral-tests',status:'not_run',reason:'syntax check failed'});
  const after = await hashes();
  report.checks.push({name:'source-unchanged-during-verification',status:JSON.stringify(after)===JSON.stringify(report.source_sha256)?'passed':'failed'});
  report.status = report.checks.every(c=>c.status==='passed') ? 'passed' : 'failed';
  report.finished_at = new Date().toISOString();
  return report;
}
export async function main(args) {
  if (args.length===1 && args[0]==='--help') {
    console.log('node app/scripts/verify-github-pages.mjs [--report NEW_FILE.json]\nRuns fixed offline tests; no GitHub login, push, deployment, or project commands. Report files are created exclusively, never overwritten.');
    return 0;
  }
  let output;
  if (args.length===2 && args[0]==='--report' && !args[1].startsWith('--')) output=resolve(args[1]);
  else if (args.length) {console.error('Use --help or --report NEW_FILE.json.');return 3;}
  try {
    const report=await verify(); const text=`${JSON.stringify(report,null,2)}\n`;
    if(output) await writeFile(output,text,{encoding:'utf8',flag:'wx'});
    process.stdout.write(text);
    return report.status==='passed'?0:1;
  } catch {process.stdout.write(`${JSON.stringify({schema_version:1,kind:'secret-tunnel.verification',suite:'github-pages',status:'error',code:'VERIFICATION_OR_REPORT_WRITE_FAILED'})}\n`);return 3;}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=await main(process.argv.slice(2));
