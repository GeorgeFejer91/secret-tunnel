import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { NetworkHub, NetworkError, DAY, SHORT_MS, invitationText, parseInvitation, seal, unseal, validateState, READ_TOOLS, WRITE_TOOLS } from '../vendor/gpt-repo-mcp/src/network/core.mjs';

const ORIGIN = 'https://fixture.shares.zrok.io';
const root = { repo_id: 'workspace', display_name: 'Fixture', root: '/fixture' };
const grant = { roots: ['workspace'], writable: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(5); } assert.fail('condition not reached'); }
function fixture(options = {}) {
  let now = 1_900_000_000_000; const clock = () => now;
  const a = new NetworkHub({ clock, pollMs: 10, jobMs: 100, ...options.a });
  const b = new NetworkHub({ clock, pollMs: 10, jobMs: 100, roots: async () => [root], send: async (_origin, packet) => a.edge(packet), ...options.b });
  return { a, b, advance: ms => { now += ms; }, close() { a.close(); b.close(); } };
}
async function pair(f, mode = 'temporary', writable = false) {
  const invitation = await f.a.create({ origin: ORIGIN, mode });
  await f.b.redeem(invitation.link, { ...grant, writable }, 'Laptop B'); return invitation;
}

test('link and copy code roundtrip with a full-entropy independent channelKey', () => {
  const id = randomBytes(16).toString('hex'); const channelKey = randomBytes(32).toString('hex');
  const expected = { v: 1, origin: ORIGIN, id, channelKey };
  assert.deepEqual(parseInvitation(invitationText(ORIGIN, id, channelKey)), expected);
  assert.deepEqual(parseInvitation(invitationText(ORIGIN, id, channelKey, true)), expected);
  assert.equal(new URL(invitationText(ORIGIN, id, channelKey)).search, '');
});
test('rejects unsafe origins, credentials, malformed code and paths', () => {
  const id = 'a'.repeat(32), key = 'b'.repeat(64);
  for (const origin of ['http://fixture.shares.zrok.io', 'https://127.0.0.1', 'https://fixture.shares.zrok.io.evil.test', 'https://user:pass@fixture.shares.zrok.io', 'https://evil.test']) {
    assert.throws(() => parseInvitation(`${origin}/network/join#${id}.${key}`));
  }
  for (const text of ['123456', 'stn1:bad', `${ORIGIN}/other#${id}.${key}`, `${ORIGIN}/network/join?key=bad#${id}.${key}`, 'x'.repeat(5000)]) assert.throws(() => parseInvitation(text));
});
test('loopback HTTP is test-only and requires an explicit constructor option', () => {
  const text = invitationText('http://127.0.0.1:4444', 'a'.repeat(32), 'b'.repeat(64));
  assert.throws(() => parseInvitation(text)); assert.equal(parseInvitation(text, true).origin, 'http://127.0.0.1:4444');
});
test('AES-GCM authenticates contents, direction, channel identity and key', () => {
  const key = 'c'.repeat(64), id = 'd'.repeat(32); const value = { fixture: 'sensitive-not-a-real-credential' };
  const packet = seal(key, id, 'request', value);
  assert.deepEqual(unseal(key, id, 'request', packet), value);
  assert.ok(!JSON.stringify(packet).includes(value.fixture));
  for (const attempt of [() => unseal('e'.repeat(64), id, 'request', packet), () => unseal(key, id, 'response', packet), () => unseal(key, 'f'.repeat(32), 'request', packet), () => unseal(key, id, 'request', { ...packet, tag: 'A'.repeat(22) })]) assert.throws(attempt, NetworkError);
});
test('cipher nonces are fresh and oversized payloads fail closed', () => {
  const key = 'c'.repeat(64), id = 'd'.repeat(32);
  assert.notEqual(seal(key, id, 'request', {}).iv, seal(key, id, 'request', {}).iv);
  assert.throws(() => seal(key, id, 'request', { data: 'x'.repeat(700_001) }));
});
test('temporary access starts on redemption, not invitation creation', async () => {
  const f = fixture(); try {
    const invitation = await f.a.create({ origin: ORIGIN, mode: 'temporary', invitationMs: DAY });
    f.advance(60_000); const result = await f.b.redeem(invitation.code, grant);
    assert.equal(result.expiresAt, 1_900_000_000_000 + 60_000 + DAY);
    assert.equal(f.a.state.peers[0].expiresAt, result.expiresAt);
  } finally { f.close(); }
});
test('persistent membership has no lease deadline but its invitation is single-use', async () => {
  const f = fixture(); try {
    const invitation = await pair(f, 'dependent'); assert.equal(f.b.state.upstream.expiresAt, null);
    const c = new NetworkHub({ roots: async () => [root], clock: f.b.clock, send: async (_o, p) => f.a.edge(p) });
    await assert.rejects(c.redeem(invitation.link, grant)); c.close();
  } finally { f.close(); }
});
test('expired invitation cannot be redeemed', async () => {
  const f = fixture(); try { const invite = await f.a.create({ origin: ORIGIN, mode: 'temporary' }); f.advance(900_001); await assert.rejects(f.b.redeem(invite.link, grant)); assert.equal(f.a.state.peers.length, 0); } finally { f.close(); }
});
test('concurrent redemption admits exactly one recipient', async () => {
  const f = fixture(); const c = new NetworkHub({ clock: f.b.clock, roots: async () => [root], send: async (_o, p) => f.a.edge(p) });
  try {
    const invite = await f.a.create({ origin: ORIGIN, mode: 'dependent' });
    const results = await Promise.allSettled([f.b.redeem(invite.link, grant), c.redeem(invite.link, grant)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.a.state.peers.length, 1);
  } finally { f.close(); c.close(); }
});
test('persistence failure cannot activate an unrecorded peer', async () => {
  const f = fixture({ a: { save: async () => { throw new Error('fixture storage failure'); } } });
  try { const invite = await f.a.create({ origin: ORIGIN, mode: 'dependent' }); await assert.rejects(f.b.redeem(invite.link, grant)); assert.equal(f.a.state.peers.length, 0); assert.equal(f.a.invites.size, 0); } finally { f.close(); }
});
test('profile transfer is encrypted, one-use, and creates no membership', async () => {
  const f = fixture(); try {
    const profile = { version: 1, settings: { fixture: true }, account: { fixture: 'NOT_A_REAL_CREDENTIAL' } };
    const invitation = await f.a.create({ origin: ORIGIN, mode: 'profile', profile });
    const result = await f.b.redeem(invitation.link, null);
    assert.deepEqual(result.profile, profile); assert.equal(f.a.state.peers.length, 0); assert.equal(f.b.state.upstream, null);
    await assert.rejects(f.b.redeem(invitation.link, null));
  } finally { f.close(); }
});
test('wrong receiving mode does not release a profile or consume its invite', async () => {
  const f = fixture(); try {
    const invite = await f.a.create({ origin: ORIGIN, mode: 'profile', profile: { version: 1 } });
    await assert.rejects(f.b.redeem(invite.link, grant), /wrong_invitation_mode/); assert.equal(f.a.invites.size, 1);
  } finally { f.close(); }
});
test('unknown local roots and implicit empty grants are rejected before joining', async () => {
  const f = fixture(); try {
    const invite = await f.a.create({ origin: ORIGIN, mode: 'dependent' });
    await assert.rejects(f.b.redeem(invite.link, { roots: ['not-approved'], writable: true }));
    await assert.rejects(f.b.redeem(invite.link, { roots: [], writable: false })); assert.equal(f.a.invites.size, 1);
  } finally { f.close(); }
});
test('peer credentials and profile contents never appear in public status', async () => {
  const f = fixture(); try { await pair(f); const report = JSON.stringify([f.a.status(), f.b.status()]); assert.ok(!report.includes(f.b.state.upstream.channelKey)); assert.ok(!report.includes('"channelKey"')); } finally { f.close(); }
});
test('one-hop topology rejects gateway creation on a joined device', async () => {
  const f = fixture(); try { await pair(f); await assert.rejects(f.b.create({ origin: ORIGIN, mode: 'dependent' }), /one_hop_only/); } finally { f.close(); }
});
test('state validation rejects damaged credentials and expired temporary grants cannot become permanent', () => {
  const f = fixture(); try {
    const state = structuredClone(f.a.state); state.peers = [{ id: 'a'.repeat(32), channelKey: 'b'.repeat(64), label: 'Peer', mode: 'temporary', expiresAt: null }];
    assert.throws(() => validateState(state)); state.peers[0].expiresAt = 1_900_000_000_000; state.peers[0].channelKey = 'short'; assert.throws(() => validateState(state));
  } finally { f.close(); }
});
test('restart retains exact peer identity and deadline, never pending invitations', async () => {
  const f = fixture(); try {
    await pair(f); const restarted = new NetworkHub({ state: f.a.state, clock: f.a.clock });
    assert.deepEqual(restarted.state, f.a.state); assert.equal(restarted.invites.size, 0); restarted.close();
  } finally { f.close(); }
});
test('request replay and stale timestamps are rejected', async () => {
  const f = fixture(); try {
    await pair(f); const up = f.b.state.upstream;
    const message = { op: 'result', jobId: 'c'.repeat(32), requestId: 'd'.repeat(32), sentAt: f.a.clock(), result: {} };
    const packet = seal(up.channelKey, up.id, 'request', message);
    await f.a.edge(packet); const reply = unseal(up.channelKey, up.id, 'response', await f.a.edge(packet)); assert.equal(reply.error, 'replayed_request');
    f.advance(120_001); await assert.rejects(f.a.edge(packet), /stale_request/);
  } finally { f.close(); }
});
test('a response from another request cannot satisfy a new request', async () => {
  const f = fixture(); try {
    await pair(f); let previous;
    f.b.send = async (_o, packet) => { if (!previous) previous = await f.a.edge(packet); return previous; };
    await f.b.rpc(f.b.state.upstream, { op: 'result', jobId: 'a'.repeat(32), result: {} });
    await assert.rejects(f.b.rpc(f.b.state.upstream, { op: 'result', jobId: 'b'.repeat(32), result: {} }), /response_mismatch/);
  } finally { f.close(); }
});
test('a remote read uses the original root id and returns the native tool result', async () => {
  let seen;
  const f = fixture({ b: { execute: async (tool, args, expectedPath) => { seen = { tool, args, expectedPath }; return { content: [{ type: 'text', text: 'fixture file' }] }; } } });
  try {
    await pair(f); void f.b.runPeer(); await until(() => f.a.remoteRoots().length === 1);
    const result = await f.a.route('repo_fetch_file', { repo_id: f.a.remoteRoots()[0].repo_id, path: 'note.txt' });
    assert.equal(seen.args.repo_id, 'workspace'); assert.equal(seen.expectedPath, '/fixture'); assert.equal(result.content[0].text, 'fixture file');
  } finally { f.close(); }
});
test('read-only peer refuses writes even when the gateway requests them', async () => {
  let writes = 0; const f = fixture({ b: { execute: async () => { writes++; return {}; } } });
  try { await pair(f); void f.b.runPeer(); await until(() => f.a.remoteRoots().length === 1); await assert.rejects(f.a.route('repo_write_file', { repo_id: f.a.remoteRoots()[0].repo_id, path: 'no.txt' }), /remote_operation_failed/); assert.equal(writes, 0); } finally { f.close(); }
});
test('explicit writable grant permits bounded file writes, not shell/GitHub/delegation', async () => {
  let writes = 0; const f = fixture({ b: { execute: async () => { writes++; return { ok: true }; } } });
  try {
    await pair(f, 'dependent', true); void f.b.runPeer(); await until(() => f.a.remoteRoots().length === 1);
    const id = f.a.remoteRoots()[0].repo_id; assert.deepEqual(await f.a.route('repo_write_file', { repo_id: id, path: 'fixture.txt' }), { ok: true }); assert.equal(writes, 1);
    for (const tool of ['repo_validate', 'github_direct_publish', 'repo_write_codex_task', 'network_admin']) await assert.rejects(f.a.route(tool, { repo_id: id }), /remote_tool_not_allowed/);
    assert.equal(READ_TOOLS.size, 5); assert.equal(WRITE_TOOLS.size, 2);
  } finally { f.close(); }
});
test('removing a local root withdraws it from discovery', async () => {
  let roots = [root]; const f = fixture({ b: { roots: async () => roots } });
  try { await pair(f); void f.b.runPeer(); await until(() => f.a.remoteRoots().length === 1); roots = []; await until(() => f.a.remoteRoots().length === 0); } finally { f.close(); }
});
test('expired membership refuses new requests on both devices', async () => {
  const f = fixture(); try { await pair(f); f.advance(DAY + 1); await assert.rejects(f.b.rpc(f.b.state.upstream, { op: 'poll', roots: [root] }), /lease_expired/); assert.equal(f.a.remoteRoots().length, 0); await f.b.runPeer(); assert.equal(f.b.lastProblem, 'lease_expired'); } finally { f.close(); }
});
test('revocation removes access and fails queued requests rather than using local files', async () => {
  const f = fixture(); try {
    await pair(f); const up = f.b.state.upstream; await f.b.rpc(up, { op: 'poll', roots: [root] });
    const promise = f.a.route('repo_fetch_file', { repo_id: f.a.remoteRoots()[0].repo_id, path: 'fixture' });
    const rejected = assert.rejects(promise, /device_revoked/); await f.a.revoke(up.id); await rejected;
    await assert.rejects(f.b.rpc(up, { op: 'poll', roots: [root] })); assert.equal(f.a.remoteRoots().length, 0);
  } finally { f.close(); }
});
test('lost write receipt never causes an automatic re-execution', async () => {
  let writes = 0; const f = fixture({ b: { execute: async () => { writes++; return { ok: true }; } } });
  try {
    await pair(f, 'dependent', true);
    f.b.send = async (_o, packet) => {
      const up = f.b.state.upstream; const input = unseal(up.channelKey, up.id, 'request', packet);
      if (input.op === 'result') throw new NetworkError('gateway_unavailable');
      return f.a.edge(packet);
    };
    void f.b.runPeer(); await until(() => f.a.remoteRoots().length === 1);
    await assert.rejects(f.a.route('repo_write_file', { repo_id: f.a.remoteRoots()[0].repo_id, path: 'fixture.txt' }), /remote_outcome_unknown/);
    assert.equal(writes, 1);
  } finally { f.close(); }
});
test('invitation capacity is bounded', async () => {
  const f = fixture(); try { for (let i = 0; i < 16; i++) await f.a.create({ origin: ORIGIN, mode: 'dependent' }); await assert.rejects(f.a.create({ origin: ORIGIN, mode: 'dependent' }), /invitation_capacity/); } finally { f.close(); }
});
test('leave persists removal and disables reconnection without copying credentials', async () => {
  let persisted; const f = fixture({ b: { save: async state => { persisted = structuredClone(state); } } });
  try { await pair(f); await f.b.leave(); assert.equal(persisted.upstream, null); assert.equal(f.b.state.upstream, null); } finally { f.close(); }
});

test('retargeting the same root id does not grant access to the replacement directory', async () => {
  let current = root; let reads = 0;
  const f = fixture({ b: { roots: async () => [current], execute: async () => { reads++; return {}; } } });
  try {
    await pair(f); void f.b.runPeer(); await until(() => f.a.remoteRoots().length === 1);
    current = { ...root, root: '/different-private-folder' };
    await until(() => f.a.remoteRoots().length === 0); assert.equal(reads, 0);
    assert.equal(f.b.state.upstream.bindings[0].path, '/fixture');
  } finally { f.close(); }
});
test('persisted grants without original directory bindings fail closed', async () => {
  const f = fixture(); try {
    await pair(f); const saved = structuredClone(f.b.state); delete saved.upstream.bindings;
    assert.throws(() => validateState(saved), /invalid_saved_state/);
  } finally { f.close(); }
});
test('real loopback HTTP transports encrypted pairing, polling and file results', async () => {
  const a = new NetworkHub({ allowLoopback: true, pollMs: 15, jobMs: 1500 });
  const captures = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const wire = Buffer.concat(chunks).toString(); captures.push(wire);
    try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await a.edge(JSON.parse(wire)))); }
    catch { res.statusCode = 403; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const b = new NetworkHub({ allowLoopback: true, roots: async () => [root], execute: async () => ({ content: [{ type: 'text', text: 'PRIVATE_FIXTURE_CONTENT' }] }) });
  try {
    const invite = await a.create({ origin: `http://127.0.0.1:${server.address().port}`, mode: 'dependent' });
    await b.redeem(invite.link, grant); void b.runPeer(); await until(() => a.remoteRoots().length === 1);
    const result = await a.route('repo_fetch_file', { repo_id: a.remoteRoots()[0].repo_id, path: 'private-fixture.txt' });
    assert.equal(result.content[0].text, 'PRIVATE_FIXTURE_CONTENT');
    const joinedWire = captures.join('');
    for (const forbidden of ['PRIVATE_FIXTURE_CONTENT', 'private-fixture.txt', b.state.upstream.channelKey]) assert.ok(!joinedWire.includes(forbidden));
  } finally { b.close(); a.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a short code is a short seed, never a short key', async () => {
  const f = fixture(); try {
    const invitation = await f.a.create({ origin: ORIGIN, mode: 'dependent', invitationMs: SHORT_MS, short: true });
    // Brevity is the whole point, and it must be a real saving over the link.
    assert.ok(invitation.short.length < 40);
    assert.ok(invitation.short.length < invitation.link.length / 3);
    assert.match(invitation.short, /^stn5:[a-z0-9-]+-[A-Z2-7]{16}$/);
    // Nothing on the wire is weaker: the channel key is still 256 bits, and the
    // gateway stored exactly what the code derives.
    const parsed = parseInvitation(invitation.short);
    assert.equal(parsed.channelKey.length, 64);
    assert.equal(parsed.id, invitation.id);
    assert.equal(parsed.origin, ORIGIN);
    // The id must not leak the key: both come from one seed, by separate labels.
    assert.ok(!parsed.channelKey.includes(parsed.id));
  } finally { f.close(); }
});
test('a short code actually pairs, and only once', async () => {
  const f = fixture(); try {
    const invitation = await f.a.create({ origin: ORIGIN, mode: 'dependent', invitationMs: SHORT_MS, short: true });
    await f.b.redeem(invitation.short, grant, 'Laptop B');
    assert.equal(f.a.state.peers.length, 1);
    // A third device, so the refusal is the invitation being spent and not this
    // device already being connected.
    const c = new NetworkHub({ clock: f.b.clock, roots: async () => [root], send: async (_o, p) => f.a.edge(p) });
    await assert.rejects(c.redeem(invitation.short, grant)); c.close();
    assert.equal(f.a.state.peers.length, 1);
  } finally { f.close(); }
});
test('a short code expires in five minutes, not fifteen', async () => {
  const f = fixture(); try {
    const invitation = await f.a.create({ origin: ORIGIN, mode: 'dependent', invitationMs: SHORT_MS, short: true });
    f.advance(SHORT_MS - 1_000); const late = new NetworkHub({ clock: f.b.clock, roots: async () => [root], send: async (_o, p) => f.a.edge(p) });
    f.advance(2_000);
    await assert.rejects(late.redeem(invitation.short, grant)); late.close();
    assert.equal(f.a.state.peers.length, 0);
  } finally { f.close(); }
});
test('brevity cannot be kept while dropping the window that justifies it', async () => {
  const f = fixture(); try {
    for (const invitationMs of [15 * 60_000, DAY]) {
      await assert.rejects(f.a.create({ origin: ORIGIN, mode: 'dependent', invitationMs, short: true }), /short_requires_short_expiry/);
    }
    // And the long forms are unchanged: no short code unless one was asked for.
    const ordinary = await f.a.create({ origin: ORIGIN, mode: 'dependent' });
    assert.equal(ordinary.short, null);
    assert.equal(ordinary.expiresAt, f.a.clock() + 15 * 60_000);
  } finally { f.close(); }
});
test('a damaged or truncated short code is refused, not silently re-derived', () => {
  const good = 'stn5:fixture-ABCDEFGHIJKLMNOP';
  assert.doesNotThrow(() => parseInvitation(good));
  for (const bad of ['stn5:fixture-ABCDEFGHIJKLMNO', 'stn5:fixture-ABCDEFGHIJKLMNOPQ', 'stn5:fixture-abcdefghijklmnop', 'stn5:fixture-ABCDEFGHIJKLMN01', 'stn5:-ABCDEFGHIJKLMNOP', 'stn5:fixture.evil-ABCDEFGHIJKLMNOP', 'stn5:']) {
    assert.throws(() => parseInvitation(bad), NetworkError);
  }
  // A short code names a zrok share, so it can never point somewhere else.
  assert.equal(parseInvitation(good).origin, 'https://fixture.shares.zrok.io');
});
