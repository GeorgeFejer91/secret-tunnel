// Newly authored verification for the Secret Tunnel GitHub MCP bridge client.
//
// Provenance: written 2026-09-17 by the local Claude compiler/tester agent from the
// documented contract in For-AI/PROTOCOLS/github-bridge-verification.md and the tool
// descriptions in vendor/gpt-repo-mcp/src/github-bridge.ts. This is NOT the recovered
// original suite from SecretTunnel_MCP_Bridge_Implementation_and_Verification.zip and
// must not be reported as such. Assertions state what the contract requires; where the
// implementation disagrees the test is expected to fail and be reported, not adjusted.
//
// Dependency-free by design: node:test, node:assert and node:http only. No SDK, no zod,
// no Git, no GitHub, no desktop broker, no project file writes. Every server below is a
// disposable loopback fixture bound to 127.0.0.1:0 and closed by its own test.
//
// All fixture values are synthetic and non-secret. The 64-character broker credential is
// the literal hex alphabet repeated four times.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createBrokerClient,
  createGitHubHandlers,
  validateBrokerInput,
  BrokerClientError
} from '../../vendor/gpt-repo-mcp/src/github-broker-client.mjs';
import {
  HEX,
  FIXTURE_CREDENTIAL,
  FIXTURE_PLAN_ID,
  FIXTURE_HEAD,
  FIXTURE_HEAD_AFTER,
  ENV_KEYS,
  statusPayload,
  receiptPayload,
  planPayload,
  VALID_PLAN_INPUT
} from './fixtures.mjs';

/* ------------------------------------------------------------------ fixtures */

const ABSENT = Symbol('absent from the environment');

function brokerEnv(url, credential = FIXTURE_CREDENTIAL, extra = {}) {
  const env = { ...extra };
  if (url !== ABSENT) env[ENV_KEYS.url] = url;
  if (credential !== ABSENT) env[ENV_KEYS.credential] = credential;
  return env;
}

function applyPayload(overrides = {}) {
  return receiptPayload({ commit: { beforeHead: FIXTURE_HEAD, afterHead: FIXTURE_HEAD_AFTER, committedPaths: ['notes.md'], ...overrides } });
}

/* ------------------------------------------------------------------- helpers */

async function mockBroker(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(record);
      try { handler(req, res, record, seen.length); } catch { try { req.socket.destroy(); } catch { /* fixture teardown */ } }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => done());
  }));
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}/`, seen };
}

function reply(res, value, status = 200, headers = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
  res.end(body);
}

async function clientFor(t, handler, options = {}, extraEnv = {}) {
  const broker = await mockBroker(t, handler);
  const env = brokerEnv(broker.url, FIXTURE_CREDENTIAL, extraEnv);
  return { broker, env, client: createBrokerClient(env, options) };
}

// Critical assertions are helpers so that the meta tests at the bottom of this file can
// prove each one actually fails when handed deliberately incorrect behaviour.

function receiptFixtureLike(overrides = {}) {
  return { ...receiptPayload(), ...overrides };
}
function refusalError(result) {
  assert.equal(result.isError, true, "expected a refusal");
  assert.equal(result.structuredContent, undefined, "a refusal must not claim to be receipt-shaped structured output");
  const parsed = JSON.parse(result.content.map(part => part.text).join(""));
  assert.ok(parsed.error && typeof parsed.error.code === "string", "refusal must carry a bounded error object");
  return parsed.error;
}
function assertBrokerError(error, code, outcome) {
  assert.ok(error instanceof BrokerClientError, `expected BrokerClientError, got ${error && error.name}`);
  assert.equal(error.code, code);
  if (outcome !== undefined) assert.equal(error.outcome, outcome);
  return true;
}

function assertSingleAttempt(seen) {
  assert.equal(seen.length, 1, `client must not retry automatically; observed ${seen.length} broker requests`);
  return true;
}

function assertNoCredential(value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!rendered.includes(FIXTURE_CREDENTIAL), 'broker credential leaked into output');
  return true;
}

async function rejectsWith(promise, code, outcome) {
  await assert.rejects(promise, error => assertBrokerError(error, code, outcome));
}

/* ------------------------------------------------- 0. fixture self-integrity */

// Guards the shared fixture module against escaping damage. The expected value is written
// independently here with String.raw, never imported from fixtures.mjs, so this fails if
// that file's literals are rewritten. A single-backslash 'C:\fixture\workspace' silently
// becomes "C:<form-feed>ixtureworkspace": every other test still passed with that value,
// which is why this check exists.
test('status fixtures preserve literal Windows paths', () => {
  const payload = statusPayload();
  const expected = String.raw`C:\fixture\workspace`;

  assert.equal(payload.workspacePath, expected);
  assert.equal(payload.repository.root, expected);

  assert.doesNotMatch(payload.workspacePath, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(payload.repository.root, /[\u0000-\u001f\u007f]/);
});

/* ----------------------------------------- A. destination and configuration */

test('no broker configuration at all disables the tools rather than failing', () => {
  assert.equal(createBrokerClient({}), null);
});

for (const [label, url] of [
  ['a routable host', 'http://10.0.0.5:8787/'],
  ['the loopback name instead of the literal address', 'http://localhost:8787/'],
  ['IPv6 loopback', 'http://[::1]:8787/'],
  ['an alternative loopback address', 'http://127.0.0.2:8787/'],
  ['a decimal-encoded loopback address', 'http://2130706433:8787/'],
  ['https', 'https://127.0.0.1:8787/'],
  ['a path suffix', 'http://127.0.0.1:8787/github'],
  ['a query suffix', 'http://127.0.0.1:8787/?x=1'],
  ['embedded credentials', 'http://user:pw@127.0.0.1:8787/'],
  ['no port', 'http://127.0.0.1/'],
  ['an out-of-range port', 'http://127.0.0.1:70000/'],
  ['a zero port', 'http://127.0.0.1:0/']
]) {
  test(`destination is restricted: ${label} is refused`, () => {
    assert.throws(() => createBrokerClient(brokerEnv(url)), error => assertBrokerError(error, 'broker_configuration'));
  });
}

test('the exact literal loopback origin is accepted, with and without a trailing slash', () => {
  assert.ok(createBrokerClient(brokerEnv('http://127.0.0.1:8787/')));
  assert.ok(createBrokerClient(brokerEnv('http://127.0.0.1:8787')));
});

for (const [label, credential] of [
  ['absent', ABSENT],
  ['too short', HEX.repeat(3)],
  ['too long', `${HEX.repeat(4)}00`],
  ['uppercase hex', HEX.repeat(4).toUpperCase()],
  ['non-hex characters', `zz${HEX.repeat(4).slice(2)}`],
  ['an empty string', '']
]) {
  test(`broker credential must be 64 lowercase hex characters: ${label} is refused`, () => {
    assert.throws(
      () => createBrokerClient(brokerEnv('http://127.0.0.1:8787/', credential)),
      error => assertBrokerError(error, 'broker_configuration')
    );
  });
}

for (const [label, options] of [
  ['a zero deadline', { timeoutMs: 0 }],
  ['a deadline above the ceiling', { timeoutMs: 30001 }],
  ['a fractional deadline', { timeoutMs: 1.5 }],
  ['a response cap below the floor', { maxResponseBytes: 127 }],
  ['a response cap above the ceiling', { maxResponseBytes: 262145 }],
  ['zero concurrency', { maxConcurrent: 0 }],
  ['concurrency above the ceiling', { maxConcurrent: 5 }]
]) {
  test(`client limits are bounded: ${label} is refused`, () => {
    assert.throws(
      () => createBrokerClient(brokerEnv('http://127.0.0.1:8787/'), options),
      error => assertBrokerError(error, 'broker_configuration')
    );
  });
}

/* ------------------------------------------------- B. request input validation */

for (const route of ['/github/push', '/github/approve', '/github/exec', '/github/status/../plan', '/', 'github/status']) {
  test(`route allowlist rejects ${route}`, () => {
    assert.throws(() => validateBrokerInput(route, {}), error => assertBrokerError(error, 'route_blocked'));
  });
}

test('status takes no arguments', () => {
  assert.deepEqual(validateBrokerInput('/github/status', {}), {});
  assert.throws(() => validateBrokerInput('/github/status', { verbose: true }), error => assertBrokerError(error, 'invalid_input'));
});

test('a plan request carries no approval authority and no command', () => {
  for (const extra of [
    { approved: true },
    { approve: true },
    { command: 'git push' },
    { shell: 'cmd.exe' },
    { planId: FIXTURE_PLAN_ID },
    { settingsRevision: 4 }
  ]) {
    assert.throws(
      () => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, ...extra }),
      error => assertBrokerError(error, 'invalid_input'),
      `expected ${JSON.stringify(extra)} to be refused`
    );
  }
});

test('commit, commit_push and push are accepted; nothing else is', () => {
  for (const action of ['COMMIT', 'merge', 'pull', 'force_push', '']) {
    assert.throws(
      () => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, action }),
      error => assertBrokerError(error, 'unsupported_action')
    );
  }
  assert.equal(validateBrokerInput('/github/plan', VALID_PLAN_INPUT).action, 'commit');
  assert.equal(
    validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, action: 'commit_push' }).action,
    'commit_push'
  );
});

test('a push plan carries no paths and no message, and refuses them if offered', () => {
  const accepted = validateBrokerInput('/github/plan', { action: 'push' });
  assert.equal(accepted.action, 'push');
  assert.deepEqual(accepted.paths, []);
  assert.equal(accepted.message, undefined);

  // Publishing an existing commit changes no file, so a caller must not be able
  // to imply that it does by smuggling paths or a message alongside it.
  for (const extra of [{ paths: ['notes.md'] }, { message: 'Fixture commit message' }]) {
    assert.throws(
      () => validateBrokerInput('/github/plan', { action: 'push', ...extra }),
      error => assertBrokerError(error, 'invalid_input')
    );
  }
});

test('path count is bounded to one through fifty distinct paths', () => {
  const many = Array.from({ length: 51 }, (_, i) => `fixture/file-${i}.txt`);
  assert.throws(() => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: [] }), error => assertBrokerError(error, 'invalid_paths'));
  assert.throws(() => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: many }), error => assertBrokerError(error, 'invalid_paths'));
  assert.throws(() => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: ['a.txt', 'a.txt'] }), error => assertBrokerError(error, 'invalid_paths'));
  assert.throws(() => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: 'a.txt' }), error => assertBrokerError(error, 'invalid_paths'));
  assert.equal(validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: many.slice(0, 50) }).paths.length, 50);
});

for (const [label, value] of [
  ['parent traversal', '../outside.txt'],
  ['interior traversal', 'src/../../outside.txt'],
  ['a current-directory segment', 'src/./notes.md'],
  ['an absolute POSIX path', '/etc/hosts'],
  ['a backslash separator', 'src\\notes.md'],
  ['a drive letter', 'C:/fixture/notes.md'],
  ['a leading dash', '-rf'],
  ['a glob character', 'src/*.md'],
  ['a bracket pathspec', 'src/[a-z].md'],
  ['a question mark', 'src/note?.md'],
  ['leading whitespace', ' notes.md'],
  ['trailing whitespace', 'notes.md '],
  ['a control character', 'notes\u0001.md'],
  ['a NUL byte', 'notes\u0000.md'],
  ['an empty segment', 'src//notes.md'],
  ['an empty string', ''],
  ['a non-string', 42]
]) {
  test(`path validation rejects ${label}`, () => {
    assert.throws(
      () => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: [value] }),
      error => assertBrokerError(error, 'invalid_path')
    );
  });
}

for (const value of [
  '.git/config', '.GIT/config', 'src/.git/hooks/pre-commit', '.env', '.env.local', '.ENV.production',
  'deploy/id_rsa', 'deploy/id_ed25519', 'config/credentials', 'config/secrets', 'certs/server.pem',
  'certs/server.key', 'certs/bundle.p12', 'certs/bundle.pfx'
]) {
  test(`sensitive path is refused: ${value}`, () => {
    assert.throws(
      () => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, paths: [value] }),
      error => assertBrokerError(error, 'sensitive_path')
    );
  });
}

test('commit message is bounded, nonempty and free of control characters', () => {
  for (const message of ['', '   ', '\t\n ', 'a'.repeat(4001), 'line\rreturn', 'nul\u0000byte', 42, null]) {
    assert.throws(
      () => validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, message }),
      error => assertBrokerError(error, 'invalid_message')
    );
  }
  assert.equal(validateBrokerInput('/github/plan', { ...VALID_PLAN_INPUT, message: 'a'.repeat(4000) }).message.length, 4000);
});

test('apply accepts only an exact desktop-issued plan identifier', () => {
  for (const planId of [undefined, '', 'plan-', FIXTURE_PLAN_ID.toUpperCase(), `${FIXTURE_PLAN_ID}0`, FIXTURE_PLAN_ID.slice(0, -1), 'plan-zzzz', `${FIXTURE_PLAN_ID}\n`, 7]) {
    assert.throws(() => validateBrokerInput('/github/apply', { planId }), error => assertBrokerError(error, 'invalid_plan_id'));
  }
  assert.deepEqual(validateBrokerInput('/github/apply', { planId: FIXTURE_PLAN_ID }), { planId: FIXTURE_PLAN_ID });
});

test('apply carries no approval authority', () => {
  assert.throws(
    () => validateBrokerInput('/github/apply', { planId: FIXTURE_PLAN_ID, approved: true }),
    error => assertBrokerError(error, 'invalid_input')
  );
});

test('non-plain request objects are refused', () => {
  for (const value of [null, undefined, 'commit', 42, [], new Map(), Object.create({ action: 'commit' })]) {
    assert.throws(() => validateBrokerInput('/github/plan', value), error => assertBrokerError(error, 'invalid_input'));
  }
});

test('the input caps keep every legal plan request inside the transport byte limit', () => {
  const paths = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(3, '0')}/${'a'.repeat(508)}`);
  const message = 'm'.repeat(4000);
  const largest = JSON.stringify(validateBrokerInput('/github/plan', { action: 'commit', paths, message }));
  assert.ok(Buffer.byteLength(largest) <= 32768, `largest legal plan body is ${Buffer.byteLength(largest)} bytes`);
});

/* ------------------------------------------------------ C. successful requests */

test('status issues exactly one bounded POST with the expected headers and empty body', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, statusPayload()));
  const result = await client.call('/github/status', {});
  assertSingleAttempt(broker.seen);
  const [request] = broker.seen;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/github/status');
  assert.equal(request.body, '{}');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.accept, 'application/json');
  assert.equal(request.headers['accept-encoding'], 'identity');
  assert.equal(request.headers.authorization, `Bearer ${FIXTURE_CREDENTIAL}`);
  assert.equal(request.headers.host, `127.0.0.1:${broker.port}`);
  assert.equal(result.enabled, true);
  assert.equal(result.repository.head, FIXTURE_HEAD);
  assert.equal(result.binding.owner, 'fixture-owner');
});

test('a plan request sends exactly the validated fields and returns the projected plan', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, planPayload()));
  const result = await client.call('/github/plan', { ...VALID_PLAN_INPUT, paths: ['notes.md'] });
  assert.deepEqual(JSON.parse(broker.seen[0].body), VALID_PLAN_INPUT);
  assert.equal(result.id, FIXTURE_PLAN_ID);
  assert.equal(result.action, 'commit');
  assert.deepEqual(result.warnings, ['fixture warning']);
  assert.equal(result.expected.localHead, FIXTURE_HEAD);
});

test('apply returns the commit outcome reported by the desktop', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, applyPayload()));
  const result = await client.call('/github/apply', { planId: FIXTURE_PLAN_ID });
  assert.deepEqual(JSON.parse(broker.seen[0].body), { planId: FIXTURE_PLAN_ID });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.commit, { beforeHead: FIXTURE_HEAD, afterHead: FIXTURE_HEAD_AFTER, committedPaths: ['notes.md'] });
});

test('an unborn repository may report a null head', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload({
    repository: { ...statusPayload().repository, head: null, unborn: true, branch: null }
  })));
  const result = await client.call('/github/status', {});
  assert.equal(result.repository.head, null);
  assert.equal(result.repository.unborn, true);
});

/* -------------------------------------------------- D. response validation */

test('invalid JSON is refused', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, '{not json'));
  await rejectsWith(client.call('/github/status', {}), 'broker_json');
});

test('a non-UTF-8 body is refused', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
  await rejectsWith(client.call('/github/status', {}), 'broker_json');
});

for (const [label, payload] of [
  ['a malformed commit identity', statusPayload({ repository: { ...statusPayload().repository, head: 'not-a-sha' } })],
  ['a non-boolean flag', statusPayload({ enabled: 'yes' })],
  ['a missing repository object', statusPayload({ repository: 'workspace' })],
  ['an oversized string field', statusPayload({ gitVersion: 'v'.repeat(200) })],
  ['an oversized list', statusPayload({ repository: { ...statusPayload().repository, stagedPaths: Array.from({ length: 501 }, (_, i) => `f${i}`) } })]
]) {
  test(`status schema is enforced: ${label} is refused`, async t => {
    const { client } = await clientFor(t, (req, res) => reply(res, payload));
    await rejectsWith(client.call('/github/status', {}), 'broker_schema');
  });
}

for (const [label, overrides] of [
  ['an unsupported plan identifier', { id: 'plan-not-hex' }],
  ['an unknown action', { action: 'deploy' }],
  ['expiry before creation', { createdAtSecs: 1700000600, expiresAtSecs: 1700000000 }],
  ['a non-integer timestamp', { createdAtSecs: 1.5 }],
  ['a missing expected-state object', { expected: null }],
  ['a malformed expected head', { expected: { ...planPayload().expected, localHead: 'nope' } }],
  ['more than fifty paths', { paths: Array.from({ length: 51 }, (_, i) => `f${i}`) }]
]) {
  test(`plan schema is enforced: ${label} is refused`, async t => {
    const { client } = await clientFor(t, (req, res) => reply(res, planPayload(overrides)));
    await rejectsWith(client.call('/github/plan', VALID_PLAN_INPUT), 'broker_schema');
  });
}

test('apply must report a real resulting commit', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, applyPayload({ afterHead: null })));
  await rejectsWith(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), 'broker_schema', 'unknown');
});

test('unknown response fields are dropped rather than forwarded', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, {
    ...statusPayload(),
    accountLogin: 'fixture-owner',
    approvalGrant: 'granted',
    settingsRevision: 9
  }));
  const result = await client.call('/github/status', {});
  assert.equal(Object.hasOwn(result, 'accountLogin'), false);
  assert.equal(Object.hasOwn(result, 'approvalGrant'), false);
  assert.equal(Object.hasOwn(result, 'settingsRevision'), false);
});

test('a blocked reason is replaced with a fixed message rather than relayed', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload({ blockedReason: 'internal detail C:\\fixture\\private\\path' })));
  const result = await client.call('/github/status', {});
  assert.ok(!result.blockedReason.includes('private'));
  assert.match(result.blockedReason, /See the desktop for details/);
});

test('credentials embedded in a remote URL are stripped', async t => {
  const remotes = [
    { name: 'origin', url: 'https://fixture-user:ghp_EXAMPLE_NOT_A_REAL_VALUE@github.com/fixture-owner/fixture-repo.git' },
    { name: 'query', url: 'https://github.com/fixture-owner/fixture-repo.git?access=fixture#frag' },
    { name: 'ssh', url: 'git@github.com:fixture-owner/fixture-repo' },
    { name: 'odd', url: 'ftp://fixture-user:pw@example.invalid/repo.git' }
  ];
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload({
    repository: { ...statusPayload().repository, remotes }
  })));
  const result = await client.call('/github/status', {});
  const byName = Object.fromEntries(result.repository.remotes.map(r => [r.name, r.url]));
  assert.ok(!byName.origin.includes('fixture-user'));
  assert.ok(!byName.origin.includes('ghp_'));
  assert.ok(!byName.query.includes('access=fixture'));
  assert.equal(byName.ssh, 'git@github.com:fixture-owner/fixture-repo');
  assert.ok(!byName.odd.includes('pw@'));
});

test('the broker credential is never reflected back to the caller', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload({
    gitVersion: `git version 2.99.0 ${FIXTURE_CREDENTIAL}`,
    workspacePath: `C:\\fixture\\${FIXTURE_CREDENTIAL}`
  })));
  const result = await client.call('/github/status', {});
  assertNoCredential(result);
  assert.match(result.gitVersion, /\[redacted\]/);
});

test('token-shaped and bearer-shaped strings are redacted from output', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload({
    gitVersion: 'ghp_EXAMPLE_NOT_A_REAL_VALUE and Bearer fixture-value-not-a-secret'
  })));
  const result = await client.call('/github/status', {});
  assert.ok(!result.gitVersion.includes('ghp_EXAMPLE'));
  assert.match(result.gitVersion, /Bearer \[redacted\]/);
});

/* --------------------------------------------------- E. transport restrictions */

for (const status of [301, 302, 303, 307, 308]) {
  test(`redirects are refused and not followed: HTTP ${status}`, async t => {
    const { broker, client } = await clientFor(t, (req, res) => {
      res.writeHead(status, { location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    });
    await rejectsWith(client.call('/github/status', {}), 'broker_redirect');
    assertSingleAttempt(broker.seen);
  });
}

test('compressed responses are refused', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload(), 200, { 'content-encoding': 'gzip' }));
  await rejectsWith(client.call('/github/status', {}), 'broker_encoding');
});

test('an explicit identity content-encoding is accepted', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, statusPayload(), 200, { 'content-encoding': 'identity' }));
  assert.equal((await client.call('/github/status', {})).enabled, true);
});

test('an oversized declared content-length is refused before the body is read', async t => {
  const { client } = await clientFor(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 100000 });
    res.end(Buffer.alloc(100000, 0x20));
  }, { maxResponseBytes: 1024 });
  await rejectsWith(client.call('/github/status', {}), 'broker_response_limit');
});

test('an oversized streamed response without a declared length is refused', async t => {
  const { client } = await clientFor(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    for (let i = 0; i < 40; i++) res.write(Buffer.alloc(1024, 0x20));
    res.end();
  }, { maxResponseBytes: 1024 });
  await rejectsWith(client.call('/github/status', {}), 'broker_response_limit');
});

test('a response within the cap is accepted', async t => {
  const small = { enabled: false, gitAvailable: false, gitVersion: null, workspacePath: null, isRepository: false, repository: null, binding: null, pendingPlans: [], blockedReason: null };
  const { client } = await clientFor(t, (req, res) => reply(res, small), { maxResponseBytes: 1024 });
  assert.equal((await client.call('/github/status', {})).enabled, false);
});

test('oversized response headers are refused', async t => {
  const { client } = await clientFor(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-fixture-padding': 'p'.repeat(32768) });
    res.end(JSON.stringify(statusPayload()));
  });
  await assert.rejects(client.call('/github/status', {}), error => {
    assert.ok(error instanceof BrokerClientError, 'oversized headers must not produce a successful result');
    return true;
  });
});

test('a protocol upgrade is refused', async t => {
  const { client } = await clientFor(t, req => {
    req.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: fixture\r\nConnection: Upgrade\r\n\r\n');
  });
  await assert.rejects(client.call('/github/status', {}), error => {
    assert.ok(error instanceof BrokerClientError, 'an upgrade must not produce a successful result');
    assert.equal(error.code, 'broker_upgrade');
    return true;
  });
});

test('the deadline is enforced when the broker never answers', async t => {
  const { broker, client } = await clientFor(t, () => { /* deliberately silent fixture */ }, { timeoutMs: 120 });
  await rejectsWith(client.call('/github/status', {}), 'broker_timeout', 'not_applied');
  assertSingleAttempt(broker.seen);
});

test('an interrupted response is reported as interrupted', async t => {
  const { client } = await clientFor(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 500 });
    res.write('{"enabled":true');
    setTimeout(() => req.socket.destroy(), 20);
  }, { timeoutMs: 2000 });
  await assert.rejects(client.call('/github/status', {}), error => {
    assert.ok(error instanceof BrokerClientError);
    assert.ok(['broker_interrupted', 'broker_network'].includes(error.code), `unexpected code ${error.code}`);
    return true;
  });
});

test('a refused connection is reported as a network failure, not a success', async t => {
  const broker = await mockBroker(t, (req, res) => reply(res, statusPayload()));
  const env = brokerEnv(`http://127.0.0.1:${broker.port}/`);
  const client = createBrokerClient(env);
  await new Promise(done => { broker.server.close(() => done()); });
  await rejectsWith(client.call('/github/status', {}), 'broker_network');
});

test('cancellation before sending never reaches the broker', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, statusPayload()));
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(client.call('/github/status', {}, { signal: controller.signal }), 'broker_canceled');
  assert.equal(broker.seen.length, 0);
});

test('cancellation in flight stops the client waiting', async t => {
  const controller = new AbortController();
  const { client } = await clientFor(t, () => { setTimeout(() => controller.abort(), 20); }, { timeoutMs: 5000 });
  await rejectsWith(client.call('/github/status', {}, { signal: controller.signal }), 'broker_canceled');
});

test('concurrent local requests are bounded', async t => {
  const { client } = await clientFor(t, (req, res) => { setTimeout(() => reply(res, statusPayload()), 150); }, { maxConcurrent: 2, timeoutMs: 5000 });
  const started = [client.call('/github/status', {}), client.call('/github/status', {})];
  await rejectsWith(client.call('/github/status', {}), 'broker_busy');
  await Promise.all(started);
  assert.equal((await client.call('/github/status', {})).enabled, true, 'the slot must be released after completion');
});

test('a broker configuration change between construction and use is refused', async t => {
  const { broker, env, client } = await clientFor(t, (req, res) => reply(res, statusPayload()));
  env[ENV_KEYS.url] = 'http://127.0.0.1:9/';
  await rejectsWith(client.call('/github/status', {}), 'broker_configuration_changed');
  assert.equal(broker.seen.length, 0);
  env[ENV_KEYS.url] = broker.url;
  env[ENV_KEYS.credential] = `ff${HEX.repeat(4).slice(2)}`;
  await rejectsWith(client.call('/github/status', {}), 'broker_configuration_changed');
});

test('read-only mode is enforced at the client, independently of the tool surface', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, statusPayload()), {}, { [ENV_KEYS.readOnlySurface]: '1' });
  assert.equal((await client.call('/github/status', {})).enabled, true);
  await rejectsWith(client.call('/github/plan', VALID_PLAN_INPUT), 'read_only');
  await rejectsWith(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), 'read_only');
  assertSingleAttempt(broker.seen);
});

/* --------------------------- F. refusal semantics and uncertain mutations */

for (const code of ['plan_not_approved', 'plan_expired', 'workspace_changed', 'content_changed', 'read_only_mode', 'not_bound', 'not_implemented']) {
  test(`a recognised precondition refusal keeps its code and is reported as refused: ${code}`, async t => {
    const { broker, client } = await clientFor(t, (req, res) => reply(res, { error: { code } }, 409));
    await rejectsWith(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), code, 'refused');
    assertSingleAttempt(broker.seen);
  });
}

test('an unrecognised refusal code is not echoed back to the model', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, { error: { code: 'internal_panic_at_C:\\fixture\\private' } }, 409));
  await assert.rejects(client.call('/github/status', {}), error => {
    assert.equal(error.code, 'broker_refused');
    assert.ok(!error.message.includes('private'));
    return true;
  });
});

test('an apply that times out is uncertain and is attempted only once', async t => {
  const { broker, client } = await clientFor(t, () => { /* silent fixture */ }, { timeoutMs: 120 });
  await rejectsWith(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), 'broker_timeout', 'unknown');
  assertSingleAttempt(broker.seen);
});

test('an apply that fails with a server error is uncertain', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, { error: { code: 'git_failed' } }, 500));
  await rejectsWith(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), 'git_failed', 'unknown');
  assertSingleAttempt(broker.seen);
});

test('an apply refused for a non-precondition reason is uncertain, because staging may already have happened', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, { error: { code: 'git_failed' } }, 400));
  await rejectsWith(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), 'git_failed', 'unknown');
});

test('an interrupted apply is uncertain and is attempted only once', async t => {
  const { broker, client } = await clientFor(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 400 });
    res.write('{"beforeHead"');
    setTimeout(() => req.socket.destroy(), 20);
  }, { timeoutMs: 2000 });
  await assert.rejects(client.call('/github/apply', { planId: FIXTURE_PLAN_ID }), error => {
    assert.equal(error.outcome, 'unknown');
    return true;
  });
  assertSingleAttempt(broker.seen);
});

test('a failed plan is never reported as uncertain, because nothing was applied', async t => {
  // Only /github/apply may report outcome=unknown. A plan failure must stay determinate
  // whichever determinate label it carries, so the model never treats it as maybe-applied.
  const { client } = await clientFor(t, (req, res) => reply(res, { error: { code: 'git_failed' } }, 500));
  await assert.rejects(client.call('/github/plan', VALID_PLAN_INPUT), error => {
    assert.equal(error.code, 'git_failed');
    assert.notEqual(error.outcome, 'unknown', 'only an apply may be uncertain');
    assert.ok(['refused', 'not_applied', 'not_sent'].includes(error.outcome), `unexpected outcome ${error.outcome}`);
    return true;
  });
});

test('no non-apply route can ever produce an uncertain outcome', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, { error: { code: 'git_failed' } }, 500));
  for (const [route, input] of [['/github/status', {}], ['/github/plan', VALID_PLAN_INPUT]]) {
    await assert.rejects(client.call(route, input), error => {
      assert.notEqual(error.outcome, 'unknown', `${route} must not be uncertain`);
      return true;
    });
  }
});

test('an input rejected before sending is never uncertain', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, applyPayload()));
  await rejectsWith(client.call('/github/apply', { planId: 'plan-nope' }), 'invalid_plan_id', 'not_sent');
  assert.equal(broker.seen.length, 0);
});

/* ------------------------------------------------------------- G. handlers */

test('handlers without a broker report an unavailable bridge instead of throwing', async () => {
  const handlers = createGitHubHandlers(null);
  for (const call of [handlers.status({}), handlers.plan(VALID_PLAN_INPUT), handlers.apply({ planId: FIXTURE_PLAN_ID })]) {
    const result = await call;
    assert.equal(result.isError, true);
    assert.equal(refusalError(result).code, 'broker_unavailable');
  }
});

test('a read-only tool surface refuses mutations at callback time', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, statusPayload()));
  const handlers = createGitHubHandlers(client, true);
  assert.equal((await handlers.status({})).isError, undefined);
  for (const result of [await handlers.plan(VALID_PLAN_INPUT), await handlers.apply({ planId: FIXTURE_PLAN_ID })]) {
    assert.equal(result.isError, true);
    assert.equal(refusalError(result).code, 'read_only');
  }
  assertSingleAttempt(broker.seen);
});

for (const [label, overrides] of [
  ['the feature is disabled', { enabled: false }],
  ['Git is unavailable', { gitAvailable: false }],
  ['the folder is not a repository', { isRepository: false }],
  ['no repository is bound', { binding: null }],
  ['the desktop reports a blocking condition', { blockedReason: 'fixture block' }]
]) {
  test(`a mutation is refused before it is sent when ${label}`, async t => {
    const { broker, client } = await clientFor(t, (req, res) => reply(res, statusPayload(overrides)));
    const handlers = createGitHubHandlers(client);
    const result = await handlers.plan(VALID_PLAN_INPUT);
    assert.equal(result.isError, true);
    assert.equal(refusalError(result).code, 'github_unavailable');
    assertSingleAttempt(broker.seen);
    assert.equal(broker.seen[0].path, '/github/status');
  });
}

test('a permitted plan checks current desktop status first, then plans', async t => {
  const { broker, client } = await clientFor(t, (req, res, record) => {
    reply(res, record.path === '/github/status' ? statusPayload() : planPayload());
  });
  const handlers = createGitHubHandlers(client);
  const result = await handlers.plan(VALID_PLAN_INPUT);
  assert.equal(result.isError, undefined);
  assert.deepEqual(broker.seen.map(r => r.path), ['/github/status', '/github/plan']);
  assert.equal(result.structuredContent.id, FIXTURE_PLAN_ID);
  assert.equal(JSON.parse(result.content[0].text).id, FIXTURE_PLAN_ID);
});

test('a handler error envelope carries an outcome and no credential', async t => {
  const { client } = await clientFor(t, (req, res, record) => {
    if (record.path === '/github/status') reply(res, statusPayload());
    else reply(res, { error: { code: 'git_failed', detail: FIXTURE_CREDENTIAL } }, 500);
  });
  const handlers = createGitHubHandlers(client);
  const result = await handlers.apply({ planId: FIXTURE_PLAN_ID });
  assert.equal(result.isError, true);
  assert.equal(refusalError(result).outcome, 'unknown');
  assertNoCredential(result);
});

test('handlers reject fabricated approval fields before contacting the broker', async t => {
  const { broker, client } = await clientFor(t, (req, res) => reply(res, statusPayload()));
  const handlers = createGitHubHandlers(client);
  const result = await handlers.apply({ planId: FIXTURE_PLAN_ID, approved: true });
  assert.equal(result.isError, true);
  assert.equal(refusalError(result).code, 'invalid_input');
  assert.equal(broker.seen.length, 0);
});

/* ------------------------------------- H. meta: the assertions can fail */
// A suite that cannot fail proves nothing. These check the critical helpers above
// against deliberately incorrect fixture data.

test('meta: the no-retry assertion fails when a second attempt is observed', () => {
  assert.doesNotThrow(() => assertSingleAttempt([{ path: '/github/apply' }]));
  assert.throws(() => assertSingleAttempt([{ path: '/github/apply' }, { path: '/github/apply' }]), /must not retry automatically/);
  assert.throws(() => assertSingleAttempt([]), /observed 0 broker requests/);
});

test('meta: the credential assertion fails on unredacted output', () => {
  assert.doesNotThrow(() => assertNoCredential({ gitVersion: 'git version 2.99.0 [redacted]' }));
  assert.throws(() => assertNoCredential({ gitVersion: `leaked ${FIXTURE_CREDENTIAL}` }), /credential leaked/);
  assert.throws(() => assertNoCredential(`nested ${FIXTURE_CREDENTIAL}`), /credential leaked/);
});

test('meta: the error assertion fails on the wrong code or outcome', () => {
  const error = new BrokerClientError('broker_timeout', 'fixture', 'unknown');
  assert.doesNotThrow(() => assertBrokerError(error, 'broker_timeout', 'unknown'));
  assert.throws(() => assertBrokerError(error, 'broker_timeout', 'refused'));
  assert.throws(() => assertBrokerError(error, 'broker_network'));
  assert.throws(() => assertBrokerError(new Error('plain'), 'broker_timeout'));
});

test('meta: a deliberately lenient stand-in would accept a destination the real client refuses', () => {
  const lenient = url => ({ url });               // accepts anything, as a wrong implementation would
  assert.doesNotThrow(() => lenient('http://10.0.0.5:8787/'));
  assert.throws(
    () => createBrokerClient(brokerEnv('http://10.0.0.5:8787/')),
    error => assertBrokerError(error, 'broker_configuration'),
    'the real client must be stricter than the lenient stand-in'
  );
});

test('meta: a tampered plan fixture is detected by the schema projection', async t => {
  const { client } = await clientFor(t, (req, res) => reply(res, planPayload({ id: `${FIXTURE_PLAN_ID}-tampered` })));
  await rejectsWith(client.call('/github/plan', VALID_PLAN_INPUT), 'broker_schema');
});

/* ------------------------------------------- H. repository creation routes */

test('the create-repository routes accept only a bounded, ordinary name', () => {
  assert.deepEqual(
    validateBrokerInput('/github/create_repository', { name: 'my-notes.v2' }),
    { name: 'my-notes.v2' },
  );

  // A name reaches a URL and a Git remote, so anything that could change the
  // request's meaning is refused before it is sent.
  for (const name of ['', '.', '..', '-dash', 'owner/repo', 'has space', 'semi;colon', 'a'.repeat(101)]) {
    assert.throws(
      () => validateBrokerInput('/github/create_repository', { name }),
      error => assertBrokerError(error, 'invalid_repository_name'),
    );
  }

  // Nothing but the name: no visibility flag a caller could flip to public.
  assert.throws(
    () => validateBrokerInput('/github/create_repository', { name: 'notes', private: false }),
    error => assertBrokerError(error, 'invalid_input'),
  );
});

test('creating a repository still runs through an approved plan id', () => {
  assert.deepEqual(
    validateBrokerInput('/github/create_repository/apply', { planId: FIXTURE_PLAN_ID }),
    { planId: FIXTURE_PLAN_ID },
  );
  for (const planId of ['', 'plan-nope', FIXTURE_PLAN_ID + 'a', 'plan-' + 'g'.repeat(32)]) {
    assert.throws(
      () => validateBrokerInput('/github/create_repository/apply', { planId }),
      error => assertBrokerError(error, 'invalid_plan_id'),
    );
  }
});

/* --------------------------- I. repository-creation response projection ----
 * These exist because the input-validation tests above passed while every
 * creation response was being parsed as a commit outcome. Accepting a request
 * proves nothing about being able to read the answer.
 */

function createdRepositoryPayload(overrides = {}) {
  return receiptPayload({ action: 'create_repository', commit: null, createdRepository: {
    fullName: 'fixture-owner/fixture-repo',
    htmlUrl: 'https://github.com/fixture-owner/fixture-repo',
    cloneUrl: 'https://github.com/fixture-owner/fixture-repo.git',
    private: true, defaultBranch: 'main', ...overrides
  } });
}

test('a create-repository response is read as a repository, not a commit outcome', async t => {
  const created = createdRepositoryPayload();
  const { client } = await clientFor(t, (req, res, record) => {
    if (record.path === '/github/status') return reply(res, statusPayload());
    if (record.path === '/github/create_repository') return reply(res, planPayload());
    return reply(res, created);
  });

  const plan = await client.call('/github/create_repository', { name: 'fixture-repo' });
  assert.equal(plan.id, FIXTURE_PLAN_ID, 'proposing a repository must yield a plan');

  const outcome = await client.call('/github/create_repository/apply', { planId: FIXTURE_PLAN_ID });
  assert.equal(outcome.createdRepository.fullName, 'fixture-owner/fixture-repo');
  assert.equal(outcome.createdRepository.private, true);
  assert.equal(outcome.createdRepository.defaultBranch, 'main');
  assert.equal(outcome.commit, null, 'a creation is not a commit');
});

test('a creation response carrying a credential or foreign host is refused', async t => {
  for (const bad of [
    { cloneUrl: 'https://token@github.com/fixture-owner/fixture-repo.git' },
    { htmlUrl: 'https://evil.invalid/fixture-owner/fixture-repo' },
    { private: 'yes' },
  ]) {
    const { client } = await clientFor(t, (req, res, record) => {
      if (record.path === '/github/status') return reply(res, statusPayload());
      return reply(res, createdRepositoryPayload(bad));
    });
    await rejectsWith(
      client.call('/github/create_repository/apply', { planId: FIXTURE_PLAN_ID }),
      'broker_schema',
    );
  }
});

test('an interrupted repository creation is reported as unknown, never as not applied', async t => {
  // The repository may already exist on GitHub, so a retry could create a
  // second one. "not_applied" would be a false reassurance.
  const { client } = await clientFor(t, (req, res, record) => {
    if (record.path === '/github/status') return reply(res, statusPayload());
    return req.socket.destroy();
  });
  await assert.rejects(
    client.call('/github/create_repository/apply', { planId: FIXTURE_PLAN_ID }),
    error => {
      assert.ok(error instanceof BrokerClientError);
      assert.equal(error.outcome, 'unknown');
      return true;
    },
  );
});
