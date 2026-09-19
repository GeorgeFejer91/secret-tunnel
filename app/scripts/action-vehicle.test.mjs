import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ActionsController, vehicleTemplate, validateTicket, safePath, LIMITS } from './action-vehicle.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-vehicle-test-'));
  const root = path.join(home, 'workspace'); const privateRoot = path.join(home, 'private');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'README.md'), 'Fixture README\n');
  const c = new ActionsController(root, privateRoot); c.initialize();
  t.after(async () => { await c.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const put = (overrides = {}) => {
    const ticket = { ...vehicleTemplate(c.workspaceId), ...overrides };
    fs.writeFileSync(path.join(root, '.chatgpt/actions/inbox', ticket.id + '.json'), JSON.stringify(ticket));
    return ticket;
  };
  return { home, root, privateRoot, c, put };
}
function select(c) { return c.snapshot().pending.map(v => ({ id: v.ticket.id, revision: v.ticket.revision, review_digest: v.review_digest })); }
async function settle(c) {
  for (let i = 0; i < 500 && (c.active || (!c.paused && c.queue.length)); i++) await sleep(10);
  assert.equal(c.active, null, 'Runner must settle within test deadline');
}
const command = (body, id = 'run') => ({ id, title: id, kind: 'command', program: '$node', args: ['-e', body], timeout_ms: 2000 });
const output = { id: 'output', title: 'Verify output', kind: 'check', check: 'nonempty', path: 'output.txt' };

for (const field of ['approved', 'auto_accept', 'policy', 'result_path', 'shell']) {
  test(`reject ticket authority field: ${field}`, t => {
    const f = setup(t); assert.throws(() => validateTicket({ ...vehicleTemplate(f.c.workspaceId), [field]: true }), /Unknown ticket field/);
  });
}
for (const file of ['../escape', '/tmp/file', 'C:/file', 'foo\\bar', 'a/../b', 'a:stream', 'CON.txt', 'file.']) {
  test(`reject unsafe path: ${file}`, t => {
    const f = setup(t); assert.throws(() => validateTicket({ ...vehicleTemplate(f.c.workspaceId), inputs: [file] }));
  });
}
for (const file of ['.env', 'x/.env.production', 'secret.pem', '.git/config', '.ssh/id_rsa', '.chatgpt/actions/reports/fake']) {
  test(`reject protected check path: ${file}`, t => {
    const f = setup(t); const ticket = vehicleTemplate(f.c.workspaceId); ticket.steps[0].path = file;
    assert.throws(() => validateTicket(ticket));
  });
}
test('submission and scanning never execute', async t => {
  const f = setup(t); f.put({ steps: [command("require('fs').writeFileSync('output.txt','done')")], verification: [output] });
  f.c.snapshot(); await f.c.tick(); await sleep(40);
  assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false); assert.equal(f.c.records.size, 0);
});
test('five visible packs and visible backlog', t => {
  const f = setup(t); for (let i = 0; i < 8; i++) f.put({ id: `job-${i}` });
  const state = f.c.snapshot(); assert.equal(state.pending.length, 5); assert.equal(state.backlog, 3);
});
test('one approval runs several commands and verification steps', async t => {
  const f = setup(t); f.put({ steps: [command("require('fs').writeFileSync('output.txt','first')"), command("require('fs').appendFileSync('output.txt',' second')", 'append')], verification: [output, { ...output, id: 'content', check: 'contains', expected: 'first second' }] });
  f.c.approve(select(f.c)); await settle(f.c); const result = f.c.detail('check-project', 1);
  assert.equal(result.status, 'succeeded'); assert.equal(result.verification_status, 'passed'); assert.equal(result.steps.length, 4);
  for (const name of ['ticket.json', 'RESULT.json', 'SUMMARY.md', 'events.jsonl', 'stdout.log', 'stderr.log']) assert.ok(fs.existsSync(path.join(f.root, '.chatgpt/actions/reports/check-project', result.attempt_id, name)));
});
test('exit zero is not verified success when expected output is absent', async t => {
  const f = setup(t); f.put({ steps: [command('process.exit(0)')], verification: [output] });
  f.c.approve(select(f.c)); await settle(f.c); const result = f.c.detail('check-project', 1);
  assert.equal(result.status, 'verification_failed'); assert.equal(result.steps[0].exit_code, 0); assert.equal(f.c.paused, true);
});
test('nonzero failure retains exit status and stops remaining steps', async t => {
  const f = setup(t); f.put({ steps: [command("console.error('fixture diagnostic');process.exit(7)"), command("require('fs').writeFileSync('unexpected.txt','bad')", 'unexpected')] });
  f.c.approve(select(f.c)); await settle(f.c); const result = f.c.detail('check-project', 1);
  assert.equal(result.status, 'failed'); assert.equal(result.steps[0].exit_code, 7); assert.equal(result.verification_status, 'not_run');
  assert.match(result.steps[0].stderr_tail, /fixture diagnostic/); assert.equal(fs.existsSync(path.join(f.root, 'unexpected.txt')), false);
});
test('editing the manifest invalidates approval', t => {
  const f = setup(t); f.put(); const selection = select(f.c); f.put({ summary: 'Changed' });
  assert.throws(() => f.c.approve(selection), /changed/); assert.equal(f.c.records.size, 0);
});
test('editing a declared input invalidates approval', t => {
  const f = setup(t); f.put(); const selection = select(f.c); fs.appendFileSync(path.join(f.root, 'README.md'), 'changed');
  assert.throws(() => f.c.approve(selection), /changed/);
});
test('queued pack rechecks declared input before starting', async t => {
  const f = setup(t); f.put({ id: 'a-change', inputs: [], steps: [command("require('fs').appendFileSync('README.md','changed')")] }); f.put({ id: 'b-check' });
  f.c.approve(select(f.c)); await settle(f.c);
  assert.equal(f.c.detail('a-change', 1).status, 'succeeded'); assert.equal(f.c.detail('b-check', 1).status, 'stale');
});
test('duplicate approval is refused', async t => {
  const f = setup(t); f.put(); const selection = select(f.c); f.c.approve(selection);
  assert.throws(() => f.c.approve(selection)); await settle(f.c); assert.equal(f.c.records.size, 1);
});
test('mixed stale batch starts nothing', t => {
  const f = setup(t); f.put({ id: 'a' }); f.put({ id: 'b' }); const selection = select(f.c); f.put({ id: 'b', title: 'Changed' });
  assert.throws(() => f.c.approve(selection)); assert.equal(f.c.records.size, 0);
});
test('six approvals cannot bypass the buffer', t => {
  const f = setup(t); for (let i = 0; i < 6; i++) f.put({ id: `job-${i}` });
  const selection = select(f.c); selection.push(selection[0]); assert.throws(() => f.c.approve(selection));
});
test('failure pauses the remaining batch', async t => {
  const f = setup(t); f.put({ id: 'a', steps: [command('process.exit(3)')] }); f.put({ id: 'b' });
  f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.queue.length, 1); assert.equal(f.c.detail('b', 1).status, 'approved'); assert.equal(f.c.paused, true);
});
test('dependencies are ordered and missing dependencies block approval', async t => {
  const f = setup(t); f.put({ id: 'a', depends_on: [{ id: 'z', revision: 1 }] }); f.put({ id: 'z' });
  assert.equal(f.c.approve(select(f.c)).accepted[0].id, 'z'); await settle(f.c);
  f.put({ id: 'missing', depends_on: [{ id: 'unknown', revision: 1 }] }); assert.throws(() => f.c.approve(select(f.c)), /Dependencies/);
});
test('cyclic dependency batch is refused', t => {
  const f = setup(t); f.put({ id: 'a', depends_on: [{ id: 'b', revision: 1 }] }); f.put({ id: 'b', depends_on: [{ id: 'a', revision: 1 }] });
  assert.throws(() => f.c.approve(select(f.c)), /Dependencies/); assert.equal(f.c.records.size, 0);
});
test('automatic mode never approves executable tickets', async t => {
  const f = setup(t); f.put({ id: 'a-code', steps: [command("require('fs').writeFileSync('output.txt','bad')")], verification: [output] }); f.put({ id: 'b-check' });
  f.c.setPolicy(true); await f.c.tick(); await settle(f.c);
  assert.equal(f.c.records.has('a-code.r1'), false); assert.equal(f.c.detail('b-check', 1).status, 'succeeded'); assert.equal(fs.existsSync(path.join(f.root, 'output.txt')), false);
});
test('automatic policy stops after five packs', async t => {
  const f = setup(t); for (let i = 0; i < 6; i++) f.put({ id: `job-${i}` });
  f.c.setPolicy(true); await f.c.tick(); await settle(f.c); await f.c.tick();
  assert.equal(f.c.records.size, 5); assert.equal(f.c.snapshot().pending.length, 1); assert.equal(f.c.policy, null);
});
test('automatic policy expires and is not restored', async t => {
  const f = setup(t); f.put(); f.c.setPolicy(true); f.c.policy.expires_at = Date.now() - 1; await f.c.tick();
  assert.equal(f.c.records.size, 0); f.c.setPolicy(true); await f.c.close();
  const fresh = new ActionsController(f.root, f.privateRoot); assert.equal(fresh.policy, null); await fresh.close();
});
test('policy approval refuses command code', t => {
  const f = setup(t); f.put({ steps: [command('process.exit(0)')] }); assert.throws(() => f.c.approve(select(f.c), 'checks_policy'), /executable code/);
});
test('timeout is a terminal failure', async t => {
  const f = setup(t); f.put({ steps: [{ ...command('setInterval(()=>{},1000)'), timeout_ms: 100 }] });
  f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.detail('check-project', 1).status, 'timed_out');
});
test('cancellation stops current and queued work', async t => {
  const f = setup(t); f.put({ id: 'a', steps: [command('setInterval(()=>{},1000)')] }); f.put({ id: 'b' });
  f.c.approve(select(f.c)); await sleep(40); await f.c.cancel(); await settle(f.c);
  assert.equal(f.c.detail('a', 1).status, 'canceled'); assert.equal(f.c.detail('b', 1).status, 'canceled');
});
test('nonterminal receipt becomes interrupted without replay', async t => {
  const f = setup(t); f.put(); f.c.approve(select(f.c)); await settle(f.c); await f.c.close();
  const file = path.join(f.c.store, 'check-project.r1.json'); const receipt = JSON.parse(fs.readFileSync(file)); receipt.status = 'running'; fs.writeFileSync(file, JSON.stringify(receipt));
  const fresh = new ActionsController(f.root, f.privateRoot); assert.equal(fresh.detail('check-project', 1).status, 'interrupted'); assert.equal(fresh.queue.length, 0); await fresh.close();
});
test('forged exported result cannot replace private verdict', async t => {
  const f = setup(t); f.put({ steps: [command('process.exit(1)')] }); f.c.approve(select(f.c)); await settle(f.c);
  const result = f.c.detail('check-project', 1); fs.writeFileSync(path.join(f.root, '.chatgpt/actions/reports/check-project', result.attempt_id, 'RESULT.json'), JSON.stringify({ status: 'succeeded' }));
  assert.equal(f.c.detail('check-project', 1).status, 'failed');
});
test('new revision retains old attempt', async t => {
  const f = setup(t); f.put(); f.c.approve(select(f.c)); await settle(f.c); f.put({ revision: 2 }); f.c.approve(select(f.c)); await settle(f.c);
  assert.equal(f.c.records.size, 2); assert.notEqual(f.c.detail('check-project', 1).attempt_id, f.c.detail('check-project', 2).attempt_id);
});
test('decided revision cannot be edited silently', t => {
  const f = setup(t); f.put(); f.c.reject(select(f.c)[0]); f.put({ summary: 'Changed decision' });
  assert.equal(f.c.snapshot().pending.length, 0); assert.match(f.c.snapshot().errors[0].message, /Increment revision/);
});
test('command arguments are literal, not shell syntax', async t => {
  const f = setup(t); f.put({ steps: [{ ...command(''), args: ['-e', 'console.log(process.argv[1])', 'hello & not-a-command'] }] }); f.c.approve(select(f.c)); await settle(f.c);
  assert.match(f.c.detail('check-project', 1).steps[0].stdout_tail, /hello & not-a-command/);
});
test('script needs no feedback boilerplate', async t => {
  const f = setup(t); f.put({ steps: [{ id: 'script', title: 'Script', kind: 'script', interpreter: 'node', body: "import fs from 'node:fs';fs.writeFileSync('output.txt','vehicle');" }], verification: [output] });
  f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.detail('check-project', 1).status, 'succeeded');
});
for (const body of ["console.log('x'.repeat(200000))", "console.log('🦄'.repeat(40000))"]) {
  test('output log is bounded in bytes: ' + body.slice(0, 17), async t => {
    const f = setup(t); f.put({ steps: [command(body)] }); f.c.approve(select(f.c)); await settle(f.c); const result = f.c.detail('check-project', 1);
    assert.ok(fs.statSync(path.join(f.root, '.chatgpt/actions/reports/check-project', result.attempt_id, 'stdout.log')).size <= LIMITS.logBytes);
  });
}
test('missing executable does not report success', async t => {
  const f = setup(t); f.put({ steps: [{ ...command(''), program: 'st-no-such-program', args: [] }] }); f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.detail('check-project', 1).status, 'failed');
});
test('workspace identity mismatch blocks admission', t => {
  const f = setup(t); f.put({ workspace_id: '0'.repeat(64) }); assert.equal(f.c.snapshot().pending.length, 0); assert.match(f.c.snapshot().errors[0].message, /different folder/);
});
test('private control storage must be outside project', t => {
  const f = setup(t); assert.throws(() => new ActionsController(f.root, path.join(f.root, 'private')), /outside/);
});
test('linked inputs are refused', { skip: process.platform === 'win32' }, t => {
  const f = setup(t); fs.symlinkSync(f.privateRoot, path.join(f.root, 'linked')); assert.throws(() => safePath(f.root, 'linked/a', true), /Symbolic/);
  fs.linkSync(path.join(f.root, 'README.md'), path.join(f.root, 'linked.md')); f.put(); assert.match(f.c.snapshot().errors[0].message, /single-link/);
});
test('linked report directory prevents execution', { skip: process.platform === 'win32' }, t => {
  const f = setup(t); fs.symlinkSync(f.privateRoot, path.join(f.root, '.chatgpt/actions/reports')); f.put(); assert.throws(() => f.c.approve(select(f.c)), /report directory/); assert.equal(f.c.active, null);
});
test('SHA and JSON checks use actual bytes', async t => {
  const f = setup(t); fs.writeFileSync(path.join(f.root, 'result.json'), '{"ok":true}');
  f.put({ verification: [{ id: 'json', title: 'JSON', kind: 'check', check: 'json', path: 'result.json' }, { id: 'sha', title: 'SHA', kind: 'check', check: 'sha256', path: 'result.json', expected: createHash('sha256').update('{"ok":true}').digest('hex') }] });
  f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.detail('check-project', 1).status, 'succeeded');
});
test('Windows batch exit code is preserved', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t); f.put({ steps: [{ id: 'cmd', title: 'Batch', kind: 'script', interpreter: 'cmd', body: '@echo off\r\necho fixture\r\nexit /b 7\r\n' }] });
  f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.detail('check-project', 1).steps[0].exit_code, 7);
});
test('backlog does not repeatedly hash all input files', t => {
  const f = setup(t); for (let i = 0; i < 12; i++) f.put({ id: `job-${String(i).padStart(2,'0')}` });
  let calls = 0; const original = f.c.bindings.bind(f.c); f.c.bindings = ticket => { calls++; return original(ticket); };
  assert.equal(f.c.snapshot().backlog, 7); assert.equal(calls, 5);
});
test('automatic mode does not override pause', t => {
  const f = setup(t); f.c.pause(); assert.throws(() => f.c.setPolicy(true), /Resume.*explicitly/); assert.equal(f.c.policy, null);
});
test('unconfirmed cleanup blocks resume and approval', t => {
  const f = setup(t); f.put(); const selection = select(f.c); f.c.cleanupBlocked = true;
  assert.throws(() => f.c.resume(), /cannot resume/); assert.throws(() => f.c.approve(selection), /cleanup was not confirmed/); assert.throws(() => f.c.setPolicy(true));
});
test('history retains compact index and complete detail', async t => {
  const f = setup(t); f.put(); f.c.approve(select(f.c)); await settle(f.c); assert.equal(f.c.records.get('check-project.r1').steps, undefined); assert.equal(f.c.detail('check-project', 1).steps.length, 2);
});
test('history capacity fails closed', t => {
  const f = setup(t); f.put(); for (let i = 0; i < LIMITS.historyRecords; i++) f.c.records.set(`old-${i}.r1`, { id: `old-${i}`, revision: 1, status: 'rejected' });
  assert.throws(() => f.c.approve([{ id: 'check-project', revision: 1, review_digest: '0'.repeat(64) }]), /history is full/);
});
test('stdout chunks remain contiguous', async t => {
  const f = setup(t); f.put({ steps: [command("process.stdout.write('first');setTimeout(()=>process.stdout.write('second\\n'),100)")] }); f.c.approve(select(f.c)); await settle(f.c); const result = f.c.detail('check-project', 1);
  const log = fs.readFileSync(path.join(f.root, '.chatgpt/actions/reports/check-project', result.attempt_id, 'stdout.log'), 'utf8'); assert.match(log, /firstsecond/); assert.equal((log.match(/\[run\]/g) ?? []).length, 1);
});
