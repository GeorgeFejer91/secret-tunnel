import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ActionsController, validateTicket, vehicleTemplate, safePath } from './action-vehicle.mjs';

export function demoTickets(workspaceId) {
  const base = vehicleTemplate(workspaceId);
  const command = (id, body) => ({ id, title: id.replaceAll('-', ' '), kind: 'command', program: '$node', args: ['-e', body], timeout_ms: 60000 });
  const check = (id, file, expected) => ({ id, title: id, kind: 'check', check: 'contains', path: file, expected });
  return [
    { ...base, id: 'demo-01-success', title: 'Create and verify a small output', summary: 'Writes one fixture output and checks its exact contents.', outcome: 'Verified output with a permanent execution receipt.', effects: ['Writes output.txt and action reports'], steps: [command('write-output', "require('fs').writeFileSync('output.txt','SecretTunnel verified fixture');console.log('fixture written')")], verification: [check('verify-content', 'output.txt', 'SecretTunnel verified fixture')] },
    { ...base, id: 'demo-02-multi-step', title: 'Run several steps under one approval', summary: 'Runs two commands and two checks as one pack.', outcome: 'Four steps recorded under the same ticket and attempt.', effects: ['Writes combined.txt and reports'], steps: [command('first-write', "require('fs').writeFileSync('combined.txt','first')"), command('append-text', "require('fs').appendFileSync('combined.txt',' second')")], verification: [check('verify-first', 'combined.txt', 'first'), check('verify-both', 'combined.txt', 'first second')] },
    { ...base, id: 'demo-03-verification-failure', title: 'Demonstrate failed verification', summary: 'The command exits zero but the expected output is missing. The queue must pause.', outcome: 'verification_failed, never falsely succeeded.', effects: ['Reports only; deliberately omits expected output'], steps: [command('zero-exit', 'process.exit(0)')], verification: [{ id: 'missing-output', title: 'Expected missing output', kind: 'check', check: 'exists', path: 'intentionally-missing.txt' }] },
    { ...base, id: 'demo-04-command-failure', title: 'Demonstrate command failure', summary: 'Deliberately exits with code 7 and a diagnostic message. The queue must pause.', outcome: 'failed with exit code 7; verification not run.', effects: ['Reports only'], steps: [command('fail-seven', "console.error('Expected fixture failure');process.exit(7)")] },
    { ...base, id: 'demo-05-cancel', title: 'Demonstrate cancellation', summary: 'Waits for 30 seconds. Click Cancel outstanding work while it is running.', outcome: 'canceled when stopped locally, with no automatic retry.', effects: ['A temporary Node process and action reports'], steps: [command('wait-for-cancel', "console.log('Cancel this fixture now');setTimeout(()=>{},30000)")] },
  ].map(validateTicket);
}
export async function createFixtures(directory) {
  const home = path.resolve(directory);
  if (fs.existsSync(home)) throw new Error('Fixture output must be a new directory; existing work is never overwritten.');
  fs.mkdirSync(home, { recursive: true });
  const workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Secret Tunnel Actions disposable verification project.\n');
  const controller = new ActionsController(workspace, path.join(home, 'fixture-private'));
  try {
    controller.initialize();
    for (const ticket of demoTickets(controller.workspaceId)) fs.writeFileSync(path.join(workspace, '.chatgpt/actions/inbox', ticket.id + '.json'), JSON.stringify(ticket, null, 2) + '\n', { flag: 'wx' });
    const manifest = { schema_version: 1, fixture: 'secret-tunnel-actions', workspace, workspace_id: controller.workspaceId, created_at: new Date().toISOString(), instructions: 'Open this workspace in an isolated Actions-only desktop profile. Approve the five packs once. The third must pause the queue. Resume to observe failure 7; resume again and cancel the last pack.' };
    fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally { await controller.close(); }
}
function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}.`);
  return args[index + 1];
}
export async function main(args) {
  if (args[0] === 'fixtures') return createFixtures(option(args, '--output'));
  if (args[0] === 'validate') {
    const workspace = fs.realpathSync(option(args, '--workspace'));
    const rel = option(args, '--file'); const file = safePath(workspace, rel);
    if (fs.statSync(file).size > 131072) throw new Error('Ticket is too large.');
    const ticket = validateTicket(JSON.parse(fs.readFileSync(file, 'utf8')));
    const metadata = JSON.parse(fs.readFileSync(safePath(workspace, '.chatgpt/actions/workspace.json'), 'utf8'));
    if (ticket.workspace_id !== metadata.workspace_id) throw new Error('Ticket workspace_id does not match the selected folder.');
    return { valid: true, ticket_id: ticket.id, revision: ticket.revision, execution_steps: ticket.steps.length, verification_steps: ticket.verification.length, executed: false };
  }
  throw new Error('Usage: action-ticket.mjs fixtures --output NEW_DIRECTORY | validate --workspace PROJECT --file .chatgpt/actions/inbox/ID.json');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
