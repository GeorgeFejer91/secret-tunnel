// Newly authored real-SDK verification for the Secret Tunnel GitHub MCP bridge.
//
// Provenance: written 2026-09-17 by the local Claude compiler/tester agent from the
// documented contract in For-AI/PROTOCOLS/github-bridge-verification.md. This is NOT the
// recovered original suite from SecretTunnel_MCP_Bridge_Implementation_and_Verification.zip.
//
// This gate uses the REAL locked dependencies installed in vendor/gpt-repo-mcp: the
// MCP TypeScript SDK, zod and typescript. No stub SDK is ever substituted. If those
// dependencies cannot be loaded the gate prints SDK_GATE_BLOCKED and fails; it never
// degrades to a mock and never reports a pass.
//
// It typechecks the real github-bridge.ts with the real compiler, then executes the real
// registerGitHubTools over a real MCP client/server pair on an in-memory transport, with
// a disposable loopback HTTP fixture standing in for the desktop broker. Only the module
// specifiers of the transpiled bridge are rewritten, to absolute paths of those same real
// dependencies; the bridge's own source text is otherwise unmodified.
//
// Run profile is selected by the verifier through SECRET_TUNNEL_VERIFY_SDK.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve, join, sep } from 'node:path';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../..');
const vendorRoot = resolve(appRoot, 'vendor/gpt-repo-mcp');
const bridgeSource = resolve(vendorRoot, 'src/github-bridge.ts');
const brokerClientSource = resolve(vendorRoot, 'src/github-broker-client.mjs');

const requested = process.env.SECRET_TUNNEL_VERIFY_SDK === '1';

/* ------------------------------------------------------------------ fixtures */

import {
  FIXTURE_CREDENTIAL,
  FIXTURE_PLAN_ID,
  FIXTURE_HEAD,
  FIXTURE_HEAD_AFTER,
  ENV_KEYS,
  statusPayload,
  planPayload as planPayloadWith,
  receiptPayload,
  VALID_PLAN_INPUT as VALID_PLAN_ARGS
} from './fixtures.mjs';

// The shared builder defaults to one warning; this suite asserted on an empty list.
const planPayload = () => planPayloadWith({ warnings: [] });

/* ------------------------------------------------- real dependency loading */

const requireVendor = createRequire(join(vendorRoot, 'package.json'));

// Read straight from the installed tree: the packages' exports maps do not expose
// their own package.json, and this is the version actually loaded above.
function installedVersion(packageName) {
  return JSON.parse(readFileSync(join(vendorRoot, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')).version;
}

function resolveReal(specifier) {
  const resolved = requireVendor.resolve(specifier);
  // The package ships both builds; prefer the ESM one the bundled server actually uses.
  const asEsm = resolved.replace(`${sep}dist${sep}cjs${sep}`, `${sep}dist${sep}esm${sep}`);
  return pathToFileURL(existsSync(asEsm) ? asEsm : resolved).href;
}

let real = null;
let blockedBecause = null;

if (requested) {
  try {
    const [zodModule, mcpModule, clientModule, memoryModule, tsModule] = await Promise.all([
      import(resolveReal('zod')),
      import(resolveReal('@modelcontextprotocol/sdk/server/mcp.js')),
      import(resolveReal('@modelcontextprotocol/sdk/client/index.js')),
      import(resolveReal('@modelcontextprotocol/sdk/inMemory.js')),
      import(resolveReal('typescript'))
    ]);
    const z = zodModule.z ?? zodModule.default?.z;
    const ts = tsModule.default ?? tsModule;
    const { McpServer } = mcpModule;
    const { Client } = clientModule;
    const { InMemoryTransport } = memoryModule;
    if (!z || !ts || !McpServer || !Client || !InMemoryTransport) {
      throw new Error('A required real dependency export was missing.');
    }
    real = {
      z,
      ts,
      McpServer,
      Client,
      InMemoryTransport,
      sdkVersion: installedVersion('@modelcontextprotocol/sdk'),
      zodVersion: installedVersion('zod'),
      tsVersion: ts.version
    };
  } catch (error) {
    blockedBecause = error;
    // The verifier scans stdout for this exact marker and reports
    // sdk_gate=blocked_missing_dependencies. It must never be printed on a pass.
    console.log(`SDK_GATE_BLOCKED: the real MCP SDK, zod or typescript could not be loaded from ${vendorRoot}: ${error.message}`);
  }
}

/* --------------------------------------------------------------- utilities */

async function mockBroker(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const record = { path: req.url, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(record);
      const value = handler(record, seen.length);
      const body = Buffer.from(JSON.stringify(value.body));
      res.writeHead(value.status ?? 200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => done());
  }));
  return { seen, url: `http://127.0.0.1:${server.address().port}/` };
}

function withBrokerEnvironment(t, url, readOnlySurface = false) {
  const previous = {
    [ENV_KEYS.url]: process.env[ENV_KEYS.url],
    [ENV_KEYS.credential]: process.env[ENV_KEYS.credential],
    [ENV_KEYS.readOnlySurface]: process.env[ENV_KEYS.readOnlySurface]
  };
  if (url === null) delete process.env[ENV_KEYS.url];
  else process.env[ENV_KEYS.url] = url;
  process.env[ENV_KEYS.credential] = FIXTURE_CREDENTIAL;
  if (readOnlySurface) process.env[ENV_KEYS.readOnlySurface] = '1';
  else delete process.env[ENV_KEYS.readOnlySurface];
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// The real bridge is TypeScript. Compile it with the real compiler and load the real
// output; only the module specifiers are rewritten to the real installed dependencies.
let loadedBridge = null;
async function realBridge() {
  if (loadedBridge) return loadedBridge;
  const { ts } = real;
  const source = ts.sys.readFile(bridgeSource);
  const transpiled = ts.transpileModule(source, {
    fileName: bridgeSource,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  });
  const rewritten = transpiled.outputText
    .replace(/(["'])zod\1/g, JSON.stringify(resolveReal('zod')))
    .replace(/(["'])\.\/github-broker-client\.mjs\1/g, JSON.stringify(pathToFileURL(brokerClientSource).href))
    // The bridge also composes the Pages verifier from this package. Rewrite
    // those specifiers so the compiled copy in the temp directory resolves them.
    .replace(/(["'])\.\/github-pages\/core\.mjs\1/g, JSON.stringify(pathToFileURL(resolve(vendorRoot, 'src/github-pages/core.mjs')).href))
    .replace(/(["'])\.\/github-pages\/http\.mjs\1/g, JSON.stringify(pathToFileURL(resolve(vendorRoot, 'src/github-pages/http.mjs')).href));
  const directory = mkdtempSync(join(tmpdir(), 'secret-tunnel-bridge-'));
  const file = join(directory, 'github-bridge.compiled.mjs');
  writeFileSync(file, rewritten);
  process.on('exit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } });
  loadedBridge = await import(pathToFileURL(file).href);
  return loadedBridge;
}

async function connectedPair(t, { readOnlySurface = false } = {}) {
  const { McpServer, Client, InMemoryTransport, z } = real;
  const { registerGitHubTools } = await realBridge();
  const server = new McpServer({ name: 'secret-tunnel-verification', version: '0.0.0-fixture' });
  // The production server always registers the repository tools before the bridge, so the
  // tools capability exists whether or not the bridge adds anything. Mirror that here:
  // without it, a server with no tools at all answers tools/list with "Method not found"
  // and the surface assertions could not distinguish that from a registration failure.
  server.registerTool(
    'fixture_sentinel',
    { title: 'Fixture sentinel', description: 'Present only so the tools capability exists.', inputSchema: z.object({}).strict() },
    async () => ({ content: [{ type: 'text', text: 'sentinel' }] })
  );
  registerGitHubTools(server, readOnlySurface);
  const client = new Client({ name: 'secret-tunnel-verification-client', version: '0.0.0-fixture' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return { server, client };
}

// A refused call may surface either as a thrown protocol error or as an isError result,
// depending on where validation rejects it. Both are refusals; neither is a success.
async function refusal(client, name, args) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    return { thrown: true, text: String(error && error.message) };
  }
  assert.equal(result.isError, true, `${name} must not succeed for ${JSON.stringify(args)}`);
  return { thrown: false, text: result.content.map(part => part.text).join('\n'), result };
}

/* ------------------------------------------------------------------- gating */

if (!requested) {
  test('real SDK gate is not requested in this profile', { skip: 'run the verifier with --sdk to execute this gate' }, () => {});
} else if (!real) {
  test('the real MCP SDK, zod and typescript must be installed', () => {
    assert.fail(`SDK_GATE_BLOCKED: ${blockedBecause && blockedBecause.message}`);
  });
} else {

  /* --------------------------------------------------- real compiler gate */

  test('the real compiler typechecks the real bridge with the project configuration', () => {
    const { ts } = real;
    const configFile = ts.readConfigFile(join(vendorRoot, 'tsconfig.json'), ts.sys.readFile);
    assert.equal(configFile.error, undefined, 'the vendored tsconfig must be readable');
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, vendorRoot);
    const program = ts.createProgram([bridgeSource], parsed.options);
    const diagnostics = [
      ...program.getSemanticDiagnostics(),
      ...program.getSyntacticDiagnostics()
    ].filter(diagnostic => diagnostic.file && resolve(diagnostic.file.fileName) === resolve(bridgeSource));
    const rendered = diagnostics.map(diagnostic =>
      `${diagnostic.file.fileName}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`).join('\n');
    assert.equal(diagnostics.length, 0, `the bridge must typecheck cleanly:\n${rendered}`);
  });

  test('the loaded dependencies are the real locked ones, not substitutes', () => {
    assert.match(real.sdkVersion, /^1\./, `unexpected MCP SDK major: ${real.sdkVersion}`);
    assert.match(real.zodVersion, /^4\./, `unexpected zod major: ${real.zodVersion}`);
    assert.match(real.tsVersion, /^5\./, `unexpected typescript major: ${real.tsVersion}`);
    assert.equal(typeof real.z.object, 'function');
    assert.equal(typeof real.McpServer, 'function');
  });

  /* ------------------------------------------------- registration surface */

  test('diagnostics remain visible without broker configuration and mutations fail closed', async t => {
    withBrokerEnvironment(t, null);
    delete process.env[ENV_KEYS.credential];
    const { client } = await connectedPair(t);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('github_runtime_status'));
    const runtime = await client.callTool({ name: 'github_runtime_status', arguments: {} });
    assert.equal(runtime.structuredContent.brokerState, 'unconfigured');
    const denied = await refusal(client, 'github_apply', { planId: FIXTURE_PLAN_ID });
    assert.match(denied.text, /broker_unavailable/);
  });

  test('invalid broker configuration leaves a safe diagnostic and refuses mutations', async t => {
    withBrokerEnvironment(t, 'http://10.0.0.5:8787/');
    const { client } = await connectedPair(t);
    const runtime = await client.callTool({ name: 'github_runtime_status', arguments: {} });
    assert.equal(runtime.structuredContent.brokerState, 'invalid_configuration');
    const denied = await refusal(client, 'github_plan', VALID_PLAN_ARGS);
    assert.match(denied.text, /broker_unavailable/);
  });

  test('the write surface advertises ten explicit diagnostic and approval-gated tools', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const names = (await client.listTools()).tools.map(tool => tool.name).filter(name => name.startsWith('github_'));
    // Every one of these either proposes something the desktop must approve, or
    // carries out something it already approved. Nothing acts on its own.
    assert.deepEqual(names.sort(), [
      'github_apply',
      'github_create_repository',
      'github_create_repository_apply',
      'github_operation_status',
      'github_pages_ensure',
      'github_pages_status',
      'github_plan',
      'github_repo_ensure',
      'github_repo_rebind',
      'github_runtime_status',
      'github_status',
    ]);
  });

  test('the read-only surface advertises diagnostics and receipt reads but no mutations', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url, true);
    const { client } = await connectedPair(t, { readOnlySurface: true });
    const names = (await client.listTools()).tools.map(tool => tool.name).filter(name => name.startsWith('github_'));
    assert.deepEqual(names.sort(), ['github_operation_status', 'github_pages_status', 'github_runtime_status', 'github_status']);
  });

  test('no tool offers approval, push or command execution', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const forbidden of ['approve', 'approval', 'push', 'exec', 'shell', 'command', 'publish', 'deploy']) {
      assert.equal(names.some(name => name.includes(forbidden)), false, `no tool may be named for ${forbidden}: ${names.join(', ')}`);
    }
  });

  test('tool annotations describe the real risk of each operation', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const tools = Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
    assert.equal(tools.github_status.annotations.readOnlyHint, true);
    assert.equal(tools.github_status.annotations.openWorldHint, false);
    assert.equal(tools.github_plan.annotations.readOnlyHint, false);
    assert.equal(tools.github_apply.annotations.destructiveHint, true);
    assert.equal(tools.github_apply.annotations.idempotentHint, false);
    for (const [name, tool] of Object.entries(tools)) {
      if (!name.startsWith('github_')) continue;
      assert.equal(tool.annotations.openWorldHint, !tool.annotations.readOnlyHint,
        `${name}: remote-capable operations must be annotated honestly`);
    }
  });

  test('the advertised schemas are strict and bounded', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const tools = Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
    assert.equal(tools.github_status.inputSchema.additionalProperties, false);
    assert.equal(tools.github_plan.inputSchema.additionalProperties, false);
    assert.equal(tools.github_apply.inputSchema.additionalProperties, false);
    assert.equal(tools.github_plan.inputSchema.properties.paths.maxItems, 50);
    // No minItems: action=push carries zero paths. The one-to-fifty floor for
    // commit and commit_push is enforced in the broker client, which is the
    // real boundary, and is asserted in client.test.mjs.
    assert.equal(tools.github_plan.inputSchema.properties.paths.minItems, undefined);
    assert.equal(tools.github_plan.inputSchema.properties.message.maxLength, 4000);
    // An enum of exactly the three publishing actions, so nothing else is even
    // advertised as callable.
    assert.deepEqual(tools.github_plan.inputSchema.properties.action.enum, [
      'commit',
      'commit_push',
      'push',
    ]);
    assert.deepEqual(tools.github_apply.inputSchema.required, ['planId']);
  });

  /* ---------------------------------------------------- calls through MCP */

  test('github_status returns the projected desktop state through the SDK transport', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const result = await client.callTool({ name: 'github_status', arguments: {} });
    assert.notEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.binding.repo, 'fixture-repo');
    assert.equal(broker.seen.length, 1);
    assert.equal(broker.seen[0].path, '/github/status');
  });

  test('the broker credential never crosses the MCP transport', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload({ gitVersion: `git ${FIXTURE_CREDENTIAL}` }) }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const result = await client.callTool({ name: 'github_status', arguments: {} });
    assert.ok(!JSON.stringify(result).includes(FIXTURE_CREDENTIAL), 'the credential leaked through the MCP transport');
  });

  test('a read-only surface refuses a plan even if the model asks for one', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url, true);
    const { client } = await connectedPair(t, { readOnlySurface: true });
    const refused = await refusal(client, 'github_plan', VALID_PLAN_ARGS);
    assert.ok(refused.thrown || refused.text.includes('read_only') || refused.text.includes('Tool github_plan not found'),
      `unexpected refusal text: ${refused.text}`);
    assert.equal(broker.seen.length, 0, 'a read-only refusal must not reach the broker');
  });

  test('the model cannot grant its own approval through github_apply', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    for (const args of [
      { planId: FIXTURE_PLAN_ID, approved: true },
      { planId: FIXTURE_PLAN_ID, approval: 'granted' },
      { planId: FIXTURE_PLAN_ID, force: true }
    ]) {
      await refusal(client, 'github_apply', args);
    }
    assert.equal(broker.seen.length, 0, 'a fabricated approval must never reach the broker');
  });

  test('the model cannot smuggle a command or an extra route through github_plan', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    for (const args of [
      { ...VALID_PLAN_ARGS, command: 'git push --force' },
      { ...VALID_PLAN_ARGS, shell: 'cmd.exe /c del /q .' },
      { ...VALID_PLAN_ARGS, route: '/github/exec' },
      { ...VALID_PLAN_ARGS, approved: true }
    ]) {
      await refusal(client, 'github_plan', args);
    }
    assert.equal(broker.seen.length, 0, 'an unknown field must be rejected before the broker is contacted');
  });

  test('only commit, commit_push and push are callable through the advertised schema', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    // Anything outside the three publishing actions is refused before the
    // broker is contacted at all.
    for (const action of ['force_push', 'merge', 'pull', 'COMMIT', '']) {
      await refusal(client, 'github_plan', { ...VALID_PLAN_ARGS, action });
    }
    assert.equal(broker.seen.length, 0);
  });

  test('a push plan still requires desktop approval and never applies by itself', async t => {
    const broker = await mockBroker(t, record =>
      record.path === '/github/plan' ? { body: planPayload() } : { body: statusPayload() },
    );
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);

    const planned = await client.callTool({ name: 'github_plan', arguments: { action: 'push' } });
    assert.equal(planned.isError, undefined, 'a push plan must be accepted');

    // Planning a push must never publish. The bridge reads status first as a
    // precondition, which is expected; what matters is that apply is not called.
    const routes = broker.seen.map(record => record.path);
    assert.ok(routes.includes('/github/plan'), 'the plan route must be reached');
    assert.ok(!routes.includes('/github/apply'), 'planning must never apply');
  });

  test('schema bounds are enforced on real calls', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    for (const args of [
      { ...VALID_PLAN_ARGS, paths: [] },
      { ...VALID_PLAN_ARGS, paths: Array.from({ length: 51 }, (_, i) => `f${i}.txt`) },
      { ...VALID_PLAN_ARGS, message: '' },
      { ...VALID_PLAN_ARGS, message: 'm'.repeat(4001) },
      { action: 'commit', paths: ['notes.md'] },
      { planId: FIXTURE_PLAN_ID }
    ]) {
      await refusal(client, 'github_plan', args);
    }
    for (const args of [{ planId: 'plan-not-hex' }, { planId: '' }, {}]) {
      await refusal(client, 'github_apply', args);
    }
    assert.equal(broker.seen.length, 0);
  });

  test('a disabled desktop feature refuses a plan after checking current status', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload({ enabled: false }) }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const refused = await refusal(client, 'github_plan', VALID_PLAN_ARGS);
    assert.match(refused.text, /github_unavailable/);
    assert.deepEqual(broker.seen.map(record => record.path), ['/github/status']);
  });

  test('the full approval sequence: plan, refusal before approval, then a local commit', async t => {
    let approved = false;
    const broker = await mockBroker(t, record => {
      if (record.path === '/github/status') return { body: statusPayload() };
      if (record.path === '/github/plan') return { body: planPayload() };
      // The desktop, not the model, owns approval. Until the fixture desktop approves,
      // apply is refused with a precondition code.
      if (!approved) return { status: 409, body: { error: { code: 'plan_not_approved' } } };
      return { body: receiptPayload() };
    });
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);

    const planned = await client.callTool({ name: 'github_plan', arguments: VALID_PLAN_ARGS });
    assert.notEqual(planned.isError, true);
    const plan = JSON.parse(planned.content[0].text);
    assert.equal(plan.id, FIXTURE_PLAN_ID);
    assert.equal(plan.action, 'commit');

    const early = await refusal(client, 'github_apply', { planId: plan.id });
    assert.match(early.text, /plan_not_approved/);
    assert.match(early.text, /"outcome":"refused"/);

    approved = true;                       // stands in for the desktop user approving
    const applied = await client.callTool({ name: 'github_apply', arguments: { planId: plan.id } });
    assert.notEqual(applied.isError, true);
    const outcome = JSON.parse(applied.content[0].text);
    assert.equal(outcome.state, 'succeeded');
    assert.equal(outcome.commit.afterHead, FIXTURE_HEAD_AFTER);
    assert.deepEqual(outcome.commit.committedPaths, ['notes.md']);
    assert.deepEqual(broker.seen.map(record => record.path),
      ['/github/status', '/github/plan', '/github/status', '/github/apply', '/github/status', '/github/apply']);
  });

  test('an uncertain apply is reported as unknown and is not retried by the bridge', async t => {
    const broker = await mockBroker(t, record => {
      if (record.path === '/github/status') return { body: statusPayload() };
      return { status: 500, body: { error: { code: 'git_failed' } } };
    });
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const refused = await refusal(client, 'github_apply', { planId: FIXTURE_PLAN_ID });
    assert.match(refused.text, /"outcome":"unknown"/);
    assert.equal(broker.seen.filter(record => record.path === '/github/apply').length, 1,
      'the bridge must not automatically retry an uncertain mutation');
  });

  /* ------------------------------------- meta: the gate can fail properly */

  test('meta: the refusal helper fails when a call unexpectedly succeeds', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    await assert.rejects(
      () => refusal(client, 'github_status', {}),
      /must not succeed/,
      'a successful call must not be counted as a refusal'
    );
  });

  test('meta: the typecheck gate reports diagnostics for deliberately broken source', () => {
    const { ts } = real;
    const broken = `${ts.sys.readFile(bridgeSource)}\nconst deliberate: number = "not a number";\n`;
    const directory = mkdtempSync(join(tmpdir(), 'secret-tunnel-broken-'));
    const file = join(directory, 'github-bridge.broken.ts');
    writeFileSync(file, broken);
    try {
      const configFile = ts.readConfigFile(join(vendorRoot, 'tsconfig.json'), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, vendorRoot);
      const program = ts.createProgram([file], parsed.options);
      const diagnostics = program.getSemanticDiagnostics().filter(d => d.file && resolve(d.file.fileName) === resolve(file));
      assert.ok(diagnostics.length > 0, 'the typecheck gate must detect a deliberate type error');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /* --------------- the declared output schema is actually strict ----------
   * A previous fix widened it with .partial() plus an optional error, which
   * admitted {}, {state:"succeeded"} and mixed receipt/refusal objects while
   * the report claimed it meant "a complete receipt or a complete refusal".
   * Checked against the emitted JSON Schema too, so a constraint that
   * disappears on emission fails here rather than passing quietly.
   */
  test('the declared receipt schema rejects empty, partial and mixed results', async () => {
    const { receiptZodSchema } = await import(pathToFileURL(resolve(vendorRoot, 'src/github-contract.mjs')).href);
    const schema = receiptZodSchema(real.z);
    const complete = receiptPayload();

    for (const [label, value] of [
      ['an empty object', {}],
      ['a partial receipt', { state: 'succeeded' }],
      ['a receipt missing most fields', { schemaVersion: 1, state: 'succeeded' }],
      ['a bare refusal', { error: { code: 'x', message: 'y', outcome: 'refused' } }],
      ['a receipt carrying a refusal as well', { ...complete, error: { code: 'x', message: 'y', outcome: 'refused' } }],
      ['a receipt with an unknown field', { ...complete, unexpected: true }],
    ]) {
      assert.equal(schema.safeParse(value).success, false, label + ' must be rejected');
    }

    assert.equal(schema.safeParse(complete).success, true, 'a complete receipt must validate');
  });

  test('the emitted JSON Schema keeps the constraints, not only the zod object', async t => {
    const broker = await mockBroker(t, () => ({ body: statusPayload() }));
    withBrokerEnvironment(t, broker.url);
    const { client } = await connectedPair(t);
    const tools = Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
    const emitted = tools.github_operation_status.outputSchema;

    assert.ok(emitted, 'the tool must advertise an output schema');
    assert.equal(emitted.additionalProperties, false, 'unknown fields must be rejected by the advertised schema');
    assert.ok(Array.isArray(emitted.required) && emitted.required.length > 0, 'required fields must survive emission');
    for (const field of ['schemaVersion', 'operationId', 'state']) {
      assert.ok(emitted.required.includes(field), field + ' must be required in the advertised schema');
    }
  });
}
