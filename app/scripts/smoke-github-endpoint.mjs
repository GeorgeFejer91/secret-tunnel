// Read-only installed-endpoint acceptance. The URL is supplied via the environment
// so a secret path is not recorded in argv or this script's output.
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { findRuntimeLayout } from './runtime-layout.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const args = process.argv.slice(2);
  if (![0, 2].includes(args.length) || (args.length && args[0] !== '--runtime-root')) {
    throw new Error('arguments');
  }
  const raw = process.env.SECRET_TUNNEL_TEST_ENDPOINT;
  if (!raw) throw new Error('endpoint_missing');
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.search
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('endpoint_invalid');
  }
  const label = process.env.SECRET_TUNNEL_TEST_LABEL ?? 'endpoint';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(label)) throw new Error('label_invalid');
  const layout = findRuntimeLayout(appRoot, args[1] ?? 'src-tauri');
  const sdk = join(layout.runtimeDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(pathToFileURL(join(sdk, 'index.js'))),
    import(pathToFileURL(join(sdk, 'streamableHttp.js')))
  ]);
  const client = new Client({ name: 'secret-tunnel-github-acceptance', version: '1.0.0' });
  const timer = setTimeout(() => { void client.close(); }, 90000);
  let report;
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const tools = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {});
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('pagination_cycle');
      cursors.add(cursor);
    }
    if (cursor) throw new Error('pagination_limit');
    const names = tools.map(tool => tool.name);
    if (new Set(names).size !== names.length) throw new Error('duplicate_tools');
    for (const name of ['github_runtime_status', 'github_status', 'github_operation_status']) {
      if (!names.includes(name)) throw new Error('required_read_tool_missing');
    }
    const result = await client.callTool({ name: 'github_runtime_status', arguments: {} });
    const runtime = result.structuredContent;
    if (result.isError || !runtime || runtime.brokerState !== 'reachable' || runtime.contractVersion !== 1
      || !/^[a-f0-9]{32}$/.test(runtime.instanceId) || !/^[a-f0-9]{12,64}$/.test(runtime.buildId)) {
      throw new Error('runtime_identity_or_broker');
    }
    const requestedMode = process.env.SECRET_TUNNEL_TEST_ACCESS_MODE ?? 'read_write';
    if (!['read', 'read_write'].includes(requestedMode) || runtime.accessMode !== requestedMode) throw new Error('access_mode');
    const writes = ['github_plan', 'github_apply', 'github_create_repository', 'github_create_repository_apply'];
    for (const name of writes) {
      if (names.includes(name) !== (requestedMode === 'read_write')) throw new Error('mutation_surface');
    }
    for (const [key, observed] of [['SECRET_TUNNEL_EXPECT_INSTANCE', runtime.instanceId], ['SECRET_TUNNEL_EXPECT_BUILD', runtime.buildId]]) {
      if (process.env[key] && process.env[key] !== observed) throw new Error('unexpected_runtime');
    }
    const statusResult = await client.callTool({ name: 'github_status', arguments: {} });
    const status = statusResult.structuredContent;
    if (statusResult.isError || status?.runtime?.instanceId !== runtime.instanceId
      || status?.runtime?.buildId !== runtime.buildId) throw new Error('status_identity');
    const bridgeNames = names.filter(name => name.startsWith('github_')).sort();
    if (JSON.stringify(bridgeNames) !== JSON.stringify([...runtime.githubTools].sort())) throw new Error('catalogue_mismatch');
    const digest = createHash('sha256').update(bridgeNames.join('\n')).digest('hex');
    if (digest !== runtime.toolCatalogDigest) throw new Error('catalogue_digest');
    report = { result: 'passed', label, checkedAt: new Date().toISOString(),
      totalTools: names.length, githubTools: bridgeNames, runtime: {
        applicationVersion: runtime.applicationVersion, buildId: runtime.buildId, instanceId: runtime.instanceId,
        contractVersion: runtime.contractVersion, accessMode: runtime.accessMode, brokerState: runtime.brokerState,
        toolCatalogDigest: digest },
      githubEnabled: status.enabled, isRepository: status.isRepository, bindingPresent: status.binding !== null,
      authentication: 'not_exercised', mutation: 'not_requested' };
  } finally { clearTimeout(timer); await client.close(); }
  if (process.env.SECRET_TUNNEL_TEST_REPORT) {
    await writeFile(resolve(process.env.SECRET_TUNNEL_TEST_REPORT), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => {
  const known = new Set(['arguments', 'endpoint_missing', 'endpoint_invalid', 'label_invalid',
    'pagination_cycle', 'pagination_limit', 'duplicate_tools', 'required_read_tool_missing',
    'runtime_identity_or_broker', 'access_mode', 'mutation_surface', 'unexpected_runtime',
    'status_identity', 'catalogue_mismatch', 'catalogue_digest']);
  const code = known.has(error?.message) ? error.message : 'endpoint_check_failed';
  // Never print arbitrary SDK/network errors: those can contain the secret URL.
  console.error(JSON.stringify({ result: 'failed', check: 'fresh_endpoint', code,
    message: 'Endpoint discovery, identity or capability verification failed. Inspect local diagnostics; no mutation was requested.' }));
  process.exitCode = 1;
});
