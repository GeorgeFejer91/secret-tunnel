import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createFixtures } from './action-ticket.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}.`);
  return value;
}
function normalized(value) {
  const clean = path.resolve(value).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}
const keep = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA']);
async function main() {
  const executable = argument('--executable');
  if (!executable) throw new Error('Usage: node scripts/launch-actions-fixture.mjs --executable PATH_TO_REBUILT_APP [--output NEW_DIRECTORY]');
  const binary = fs.realpathSync(executable);
  if (!fs.statSync(binary).isFile()) throw new Error('Executable must be a regular file.');
  const output = path.resolve(argument('--output', path.join(os.tmpdir(), `st-desktop-actions-${randomUUID()}`)));
  const fixture = await createFixtures(output);
  const profile = path.join(output, 'native-profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ workspacePath: fixture.workspace, accessMode: 'read_write', github: { enabled: false } }, null, 2));
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key.toUpperCase()))), SECRET_TUNNEL_CONFIG_DIR: profile, SECRET_TUNNEL_WORKSPACE_PATH: fixture.workspace, SECRET_TUNNEL_ACTIONS_ONLY: '1' };
  const preflight = path.join(output, 'profile-report.json');
  const probe = spawnSync(binary, [], { env: { ...environment, SECRET_TUNNEL_PROFILE_REPORT: preflight }, timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 65536 });
  if (probe.error || probe.status !== 0 || !fs.existsSync(preflight)) throw new Error('Isolated profile preflight failed; desktop was not launched. Rebuild the candidate before retrying with a fresh output directory.');
  const report = JSON.parse(fs.readFileSync(preflight, 'utf8'));
  if (report.actionsFramework !== 1 || report.actionsOnly !== true || !report.isolatedProfile || normalized(report.profileDir) !== normalized(profile)) throw new Error('This binary did not attest the isolated Actions-only profile. Refusing to launch an old or incompatible build.');
  console.log(`Isolated workspace: ${fixture.workspace}\nOpen Actions and review the five packs together.\nThe first two should succeed. The third deliberately fails verification and pauses the queue.\nResume once: the fourth should fail with exit 7 and pause again.\nResume again, then cancel the fifth while it runs.\nClose the main window to finish. Do not enable autostart or zrok during this test.\nReports remain in: ${output}`);
  await new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: environment, stdio: 'inherit' });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`Desktop exited ${code}; inspect the fixture and profile reports.`)));
  });
  const expected = { 'demo-01-success': 'succeeded', 'demo-02-multi-step': 'succeeded', 'demo-03-verification-failure': 'verification_failed', 'demo-04-command-failure': 'failed', 'demo-05-cancel': 'canceled' };
  const checks = [];
  for (const [id, status] of Object.entries(expected)) {
    const dir = path.join(fixture.workspace, '.chatgpt/actions/reports', id);
    let receipt = null;
    if (fs.existsSync(dir)) {
      for (const attempt of fs.readdirSync(dir)) {
        if (!/^attempt-[a-f0-9-]+$/.test(attempt)) continue;
        const file = path.join(dir, attempt, 'RESULT.json');
        if (fs.existsSync(file) && fs.statSync(file).size <= 524288) {
          const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (candidate.id === id && candidate.workspace_id === fixture.workspace_id && candidate.revision === 1) receipt = candidate;
        }
      }
    }
    const passed = receipt?.status === status && (status !== 'succeeded' || receipt.verification_status === 'passed') && (id !== 'demo-04-command-failure' || receipt.steps?.[0]?.exit_code === 7);
    checks.push({ id, expected: status, observed: receipt?.status ?? 'missing', passed, attempt_id: receipt?.attempt_id });
  }
  const result = { schema_version: 1, status: checks.every(c => c.passed) ? 'fixture_receipts_match_expected' : 'fixture_not_completed_or_failed', binary, preflight: report, checks, remaining_manual_checks: ['Verify only the local Actions window can approve.', 'Verify closing Actions does not stop the tunnel or approved queue.', 'Verify the public MCP write tools reject protected report paths.', 'Verify owned descendants terminate and cannot continue after cancellation.'], note: 'Receipt checks do not independently observe mouse clicks or prove process sandboxing.' };
  fs.writeFileSync(path.join(output, 'NATIVE-RESULT.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = checks.every(c => c.passed) ? 0 : 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
