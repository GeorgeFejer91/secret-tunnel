import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { ActionsController, validateTicket, vehicleTemplate } from './action-vehicle.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-framework-'));
  const workspace = path.join(home, 'project with spaces');
  const privateRoot = path.join(home, 'private');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'README.md'), 'Fixture only\n');
  const c = new ActionsController(workspace, privateRoot); c.initialize();
  t.after(async () => { await c.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, workspace, privateRoot, c };
}
function submit(f, ticket) {
  fs.writeFileSync(path.join(f.workspace, '.chatgpt/actions/inbox', ticket.id + '.json'), JSON.stringify(ticket));
}
function picks(c) { return c.snapshot().pending.map(v => ({ id: v.ticket.id, revision: v.ticket.revision, review_digest: v.review_digest })); }
async function settled(c) {
  for (let i = 0; c.active && i < 500; i++) await sleep(10);
  assert.equal(c.active, null);
}
for (const value of [undefined, null, 42, ['coerced-id']]) {
  test(`identity is a string, not coercible ${JSON.stringify(value)}`, t => {
    const f = fixture(t);
    const ticket = vehicleTemplate(f.c.workspaceId); ticket.id = value;
    assert.throws(() => validateTicket(ticket));
    ticket.id = 'valid'; ticket.steps[0].id = value;
    assert.throws(() => validateTicket(ticket));
  });
}
test('control directory itself cannot be used by built-in checks', t => {
  const f = fixture(t); const ticket = vehicleTemplate(f.c.workspaceId);
  ticket.steps[0].path = '.CHATGPT/ACTIONS';
  assert.throws(() => validateTicket(ticket));
});
test('more than 32 small manifests remain visible to the bounded scan', t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) submit(f, { ...vehicleTemplate(f.c.workspaceId), id: `pack-${String(i).padStart(2, '0')}` });
  const state = f.c.snapshot();
  assert.equal(state.pending.length, 5); assert.equal(state.backlog, 45); assert.equal(state.scan_truncated, false);
});
test('cancellation still stops active work when a queued receipt cannot be saved', async t => {
  const f = fixture(t); const base = vehicleTemplate(f.c.workspaceId);
  submit(f, { ...base, id: 'a-active', steps: [{ id: 'wait', title: 'Wait', kind: 'command', program: '$node', args: ['-e', 'setTimeout(()=>{},30000)'], timeout_ms: 60000 }] });
  submit(f, { ...base, id: 'b-queued' });
  f.c.approve(picks(f.c)); await sleep(50);
  const original = f.c.save.bind(f.c);
  f.c.save = (receipt, ticket) => { if (receipt.id === 'b-queued') throw new Error('fixture disk failure'); return original(receipt, ticket); };
  await f.c.cancel(); await settled(f.c);
  assert.equal(f.c.detail('a-active', 1).status, 'canceled');
  assert.match(f.c.lastError, /receipt failed/);
});

function rpcWorker(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-worker-e2e-'));
  const workspace = path.join(home, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'Worker IPC fixture\n');
  const privateRoot = path.join(home, 'private');
  const child = spawn(process.execPath, [path.join(here, 'action-vehicle.mjs'), '--worker'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let serial = 0; let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
  let tearingDown = false;
  // A teardown write can race the worker's exit and land on a closed pipe; that is expected.
  // Any other stream failure must still surface as a test failure.
  child.stdin.on('error', err => {
    if (tearingDown || child.exitCode !== null || child.signalCode !== null) return;
    throw err;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const reply = JSON.parse(line); const wait = pending.get(reply.id);
    if (!wait) return;
    pending.delete(reply.id); clearTimeout(wait.timer);
    if (reply.ok) wait.resolve(reply.result);
    else wait.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
  });
  child.on('exit', code => {
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(`Worker exited ${code}: ${errors}`)); }
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 8000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  t.after(async () => {
    tearingDown = true;
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      try { await request('shutdown'); } catch {}
      child.kill(); await exited;
    }
    lines.close(); fs.rmSync(home, { recursive: true, force: true });
  });
  return { workspace, privateRoot, request, child };
}
test('real worker pipe: submit, review, approve, execute, verify, inspect, and restart without replay', async t => {
  const f = rpcWorker(t);
  await f.request('init', { workspace: f.workspace, private_root: f.privateRoot });
  const setup = await f.request('initialize');
  const ticket = { ...setup.template, id: 'ipc-success', steps: [{ id: 'write', title: 'Write fixture', kind: 'script', interpreter: 'node', body: "import fs from 'node:fs'; fs.writeFileSync('output.txt', 'verified fixture'); console.log('created fixture');", timeout_ms: 3000 }], verification: [{ id: 'content', title: 'Verify actual output', kind: 'check', check: 'contains', path: 'output.txt', expected: 'verified fixture' }] };
  fs.writeFileSync(path.join(f.workspace, '.chatgpt/actions/inbox/ipc-success.json'), JSON.stringify(ticket));
  const list = await f.request('list');
  assert.equal(list.pending.length, 1);
  assert.equal(fs.existsSync(path.join(f.workspace, 'output.txt')), false);
  await assert.rejects(f.request('execute', { id: 'ipc-success' }), /Unknown local action/);
  const view = list.pending[0];
  const approval = { id: view.ticket.id, revision: 1, review_digest: view.review_digest };
  await f.request('approve', { selections: [approval] });
  await assert.rejects(f.request('approve', { selections: [approval] }));
  let result;
  for (let i = 0; i < 200; i++) {
    result = await f.request('detail', { id: 'ipc-success', revision: 1 });
    if (result.status === 'succeeded') break;
    await sleep(20);
  }
  assert.equal(result.status, 'succeeded'); assert.equal(result.verification_status, 'passed');
  const dir = path.join(f.workspace, '.chatgpt/actions/reports/ipc-success', result.attempt_id);
  for (const name of ['ticket.json', 'RESULT.json', 'SUMMARY.md', 'events.jsonl', 'stdout.log', 'stderr.log']) assert.ok(fs.existsSync(path.join(dir, name)), name);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'RESULT.json'))).attempt_id, result.attempt_id);
  assert.match(fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8'), /created fixture/);
  await f.request('shutdown');
  const later = new ActionsController(f.workspace, f.privateRoot);
  assert.equal(later.snapshot().pending.length, 0);
  assert.equal(later.detail('ipc-success', 1).attempt_id, result.attempt_id);
  await later.close();
});
test('real worker denies folder switch while approved work is running', async t => {
  const f = rpcWorker(t);
  await f.request('init', { workspace: f.workspace, private_root: f.privateRoot });
  const { template } = await f.request('initialize');
  template.steps = [{ id: 'wait', title: 'Wait fixture', kind: 'command', program: '$node', args: ['-e', 'setTimeout(()=>{},30000)'], timeout_ms: 60000 }];
  fs.writeFileSync(path.join(f.workspace, '.chatgpt/actions/inbox/check-project.json'), JSON.stringify(template));
  const { pending } = await f.request('list');
  await f.request('approve', { selections: pending.map(v => ({ id: v.ticket.id, revision: v.ticket.revision, review_digest: v.review_digest })) });
  await assert.rejects(f.request('prepare_switch'), /Finish or cancel/);
  await f.request('cancel');
  for (let i = 0; i < 200 && (await f.request('list')).active; i++) await sleep(20);
  assert.equal((await f.request('detail', { id: 'check-project', revision: 1 })).status, 'canceled');
  assert.equal((await f.request('prepare_switch')).ready, true);
});

test('fixture generator makes exactly five unapproved packs and never runs their commands', async t => {
  const { createFixtures } = await import('./action-ticket.mjs');
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fixtures-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const manifest = await createFixtures(path.join(outer, 'fresh'));
  const inbox = path.join(manifest.workspace, '.chatgpt/actions/inbox');
  assert.equal(fs.readdirSync(inbox).filter(n => n.endsWith('.json')).length, 5);
  assert.equal(fs.existsSync(path.join(manifest.workspace, 'output.txt')), false);
  for (const name of fs.readdirSync(inbox)) validateTicket(JSON.parse(fs.readFileSync(path.join(inbox, name))));
  await assert.rejects(createFixtures(path.join(outer, 'fresh')), /existing work is never overwritten/);
});
