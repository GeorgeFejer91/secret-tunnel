/** Private companion: starts without zrok, and is never itself publicly shared. */
import { createServer } from 'node:http';
import { readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { RootRegistry } from '../services/root-registry.js';
import { toolRegistry } from '../tools/registry.js';
import { NetworkHub, NetworkError, MAX_WIRE, WRITE_TOOLS } from './core.mjs';

function required(name) { const value = process.env[name]; if (!value) throw new Error('network_configuration_missing'); return value; }
function equal(left, right) { if (typeof left !== 'string') return false; const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
async function boundedJson(response) {
  if (!response.ok || !response.body) throw new NetworkError('native_storage_unavailable');
  const reader = response.body.getReader(); const chunks = []; let count = 0;
  try {
    while (true) { const value = await reader.read(); if (value.done) break; count += value.value.length; if (count > MAX_WIRE) throw new NetworkError('payload_too_large'); chunks.push(value.value); }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { await reader.cancel().catch(() => {}); }
}
export async function startNetworkService() {
  const descriptor = required('SECRET_TUNNEL_NETWORK_DESCRIPTOR');
  const instance = required('SECRET_TUNNEL_NETWORK_INSTANCE');
  const adminKey = required('SECRET_TUNNEL_NETWORK_ADMIN_KEY');
  const mcpKey = required('SECRET_TUNNEL_NETWORK_MCP_KEY');
  const broker = required('SECRET_TUNNEL_BROKER_URL');
  const brokerKey = required('SECRET_TUNNEL_BROKER_TOKEN');
  const config = required('SECRET_TUNNEL_NETWORK_CONFIG');
  const settingsPath = required('SECRET_TUNNEL_NETWORK_SETTINGS');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(broker)) throw new Error('invalid_native_broker');
  const native = async (action, state) => boundedJson(await fetch(`${broker}/network/state`, {
    method: 'POST', headers: { Authorization: `Bearer ${brokerKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(state === undefined ? {} : { state }) }), redirect: 'error', signal: AbortSignal.timeout(10_000)
  }));
  async function localContext() {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    const selected = [settings.workspacePath, ...(settings.extraFolders ?? [])].filter(value => typeof value === 'string');
    if (!selected.length) return { registry: await RootRegistry.fromConfig({ repos: [], limits: {} }), roots: [], writable: false };
    // Settings removal and read-only changes take effect even before the main MCP restarts.
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const approved = new Set(await Promise.all(selected.map(async value => normalize(await realpath(value)))));
    const registry = await RootRegistry.fromFile(config);
    const roots = registry.list().filter(root => approved.has(normalize(root.root)));
    return { registry, roots, writable: settings.accessMode === 'read_write' };
  }
  const loaded = await native('load');
  const hub = new NetworkHub({
    state: loaded.state,
    save: async state => { await native('save', state); },
    roots: async () => (await localContext()).roots,
    execute: async (name, args, expectedPath) => {
      const current = await localContext();
      if (!current.roots.some(root => root.repo_id === args.repo_id && root.root === expectedPath)) throw new NetworkError('root_not_granted');
      if (WRITE_TOOLS.has(name) && !current.writable) throw new NetworkError('read_only');
      const tool = toolRegistry.find(value => value.name === name);
      if (!tool) throw new NetworkError('tool_unavailable');
      return tool.handler(tool.inputSchema.parse(args), { registry: current.registry });
    }
  });
  let active = 0; let administrative = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const answer = (status, value) => { if (!res.destroyed) { res.writeHead(status); res.end(JSON.stringify(value)); } };
    const admin = req.url === '/control';
    if (req.method !== 'POST' || req.headers.origin || !equal(req.headers.authorization, `Bearer ${admin ? adminKey : mcpKey}`)) { answer(403, { error: 'forbidden' }); return; }
    if (!['/control', '/edge', '/route', '/roots'].includes(req.url)) { answer(404, { error: 'not_found' }); return; }
    if ((!admin && active >= 30) || (admin && administrative)) { answer(429, { error: 'busy' }); return; }
    active++; if (admin) administrative = true;
    try {
      const chunks = []; let count = 0;
      for await (const chunk of req) { count += chunk.length; if (count > MAX_WIRE) throw new NetworkError('payload_too_large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      let output;
      if (req.url === '/edge') output = await hub.edge(input);
      else if (req.url === '/route') output = await hub.route(input.tool, input.args);
      else if (req.url === '/roots') output = { repos: hub.remoteRoots() };
      else {
        switch (input.action) {
          case 'status': output = { ...hub.status(), roots: (await localContext()).roots }; break;
          case 'create': output = await hub.create(input.options); break;
          case 'redeem': output = await hub.redeem(input.invitation, input.grant, input.label); void hub.runPeer(); break;
          case 'revoke': await hub.revoke(input.id); output = hub.status(); break;
          case 'leave': await hub.leave(); output = hub.status(); break;
          default: throw new NetworkError('unknown_action');
        }
      }
      answer(200, output);
    } catch (error) { answer(400, { error: error instanceof NetworkError ? error.code : 'network_operation_failed' }); }
    finally { active--; if (admin) administrative = false; }
  });
  server.headersTimeout = 5_000; server.requestTimeout = 30_000; server.keepAliveTimeout = 1_000; server.maxConnections = 40;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const temporary = `${descriptor}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, instance, port: address.port }), { mode: 0o600 });
  await rename(temporary, descriptor);
  const timer = setInterval(() => { void hub.runPeer(); }, 1_000);
  void hub.runPeer();
  let closing = false;
  async function close() {
    if (closing) return; closing = true; clearInterval(timer); hub.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { const record = JSON.parse(await readFile(descriptor, 'utf8')); if (record.pid === process.pid && record.instance === instance) await unlink(descriptor); } catch { /* Another generation may already own the descriptor. */ }
  }
  process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
  process.stdin.resume(); process.stdin.once('end', () => { void close(); });
  return { close };
}
