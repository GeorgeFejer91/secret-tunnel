import { readFile } from 'node:fs/promises';
import type { Express } from 'express';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const LIMIT = 1_048_576;
export function networkEnabled(): boolean { return Boolean(process.env.SECRET_TUNNEL_NETWORK_DESCRIPTOR && process.env.SECRET_TUNNEL_NETWORK_MCP_KEY); }
async function call(path: '/edge' | '/route' | '/roots', body: unknown): Promise<unknown> {
  const file = process.env.SECRET_TUNNEL_NETWORK_DESCRIPTOR;
  const credential = process.env.SECRET_TUNNEL_NETWORK_MCP_KEY;
  if (!file || !credential) throw new Error('network_unavailable');
  const descriptor = JSON.parse(await readFile(file, 'utf8')) as { version: number; port: number; instance: string };
  if (descriptor.version !== 1 || descriptor.instance !== process.env.SECRET_TUNNEL_NETWORK_INSTANCE || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535) throw new Error('network_unavailable');
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(path === '/roots' ? 3_000 : path === '/edge' ? 25_000 : 50_000)
  });
  const reader = response.body?.getReader(); if (!reader) throw new Error('network_unavailable');
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; count += item.value.length; if (count > LIMIT) throw new Error('network_payload_limit'); chunks.push(item.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!response.ok) {
    const error = typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : 'network_unavailable';
    throw new Error(/^[a-z_]{1,80}$/.test(error) ? error : 'network_unavailable');
  }
  return value;
}
export function mountNetworkGateway(app: Express): void {
  if (!networkEnabled()) return;
  app.post('/network/v1', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await call('/edge', req.body)); }
    catch { res.status(403).json({ error: 'network_request_refused' }); }
  });
  // No browser redemption: pasting into the native application is deliberate.
  app.get('/network/join', (_req, res) => { res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store'); res.type('text').send('Paste this invitation into Secret Tunnel → Network. Do not share the link publicly.'); });
}
export async function networkTool(name: string, args: Record<string, unknown>, local: () => Promise<CallToolResult>): Promise<CallToolResult> {
  if (typeof args.repo_id === 'string' && args.repo_id.startsWith('peer:')) {
    try { return CallToolResultSchema.parse(await call('/route', { tool: name, args })); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'network_unavailable' }] }; }
  }
  const result = await local();
  if (name !== 'repo_list_roots' || !networkEnabled() || result.isError) return result;
  // Local roots stay usable during a peer-service outage. Never substitute a local
  // root for a failed remote request, and never overwrite the local tool result.
  try {
    const remote = await call('/roots', {}) as { repos?: unknown[] };
    if (!Array.isArray(remote.repos) || remote.repos.length === 0) return result;
    const localData = result.structuredContent;
    if (!localData || !Array.isArray(localData.repos)) return result;
    const value = { ...localData, repos: [...localData.repos, ...remote.repos] };
    return { ...result, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch { return result; }
}
