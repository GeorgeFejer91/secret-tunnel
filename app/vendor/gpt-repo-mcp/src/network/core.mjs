/** Secret Tunnel's one-hop device channel. Node built-ins only; no shell or SDK proxy. */
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

export const DAY = 86_400_000;
export const MAX_WIRE = 1_048_576;
export const READ_TOOLS = new Set(['repo_tree', 'repo_search', 'repo_fetch_file', 'repo_read_many', 'repo_policy_explain']);
export const WRITE_TOOLS = new Set(['repo_write_file', 'repo_write_changes']);
const MAX_DEVICES = 16;
const HEX_ID = /^[a-f0-9]{32}$/;
const HEX_KEY = /^[a-f0-9]{64}$/;
const randomId = () => randomBytes(16).toString('hex');
const randomKey = () => randomBytes(32).toString('hex');
export const SHORT_MS = 5 * 60_000;
/* The short code.
 *
 * A short invitation must not be a short key. The wire key stays a full 256
 * bits; what shrinks is the seed the two ends derive it from - ten random bytes,
 * eighty bits, written as sixteen base32 characters. Nothing on the wire is
 * weaker, and the gateway stores the derived id and key exactly as it stores a
 * random pair, so the rest of the protocol cannot tell the difference.
 *
 * Eighty bits is not offline-grade, and it does not have to be: the seed is
 * never handed to an attacker in a form they can grind at home. The only way to
 * test a guess is to redeem it against the gateway, one network round trip at a
 * time, against an invitation that is single-use and expires in five minutes.
 * That window is the other half of the design, which is why a short code is
 * refused at any other expiry.
 *
 * The origin rides along as the zrok share name, because `publicOrigin` already
 * requires every gateway to be `<name>.shares.zrok.io`. A loopback test origin
 * cannot be written this way, so short codes are zrok-only by construction.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SHORT_BYTES = 10;
const SHORT_CODE = /^([a-z0-9-]+)-([A-Z2-7]{16})$/;
const ZROK_NAME = /^[a-z0-9-]+$/;
function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  let bits = 0, value = 0; const out = [];
  for (const character of text) {
    const index = BASE32.indexOf(character);
    need(index >= 0, 'invalid_invitation');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
/// One seed decides both halves of the channel. Separate `info` strings keep the
/// id and the key independent, so learning the public id says nothing about the key.
function deriveFromSeed(seed) {
  const derive = (info, length) => Buffer.from(hkdfSync('sha256', seed, 'secret-tunnel-short-invitation', info, length)).toString('hex');
  return { id: derive('id', 16), channelKey: derive('key', 32) };
}
export function shortInvitationText(origin, seed) {
  const name = new URL(origin).hostname.replace(/\.shares\.zrok\.io$/, '');
  need(ZROK_NAME.test(name) && name.includes('.') === false, 'unsupported_gateway');
  return `stn5:${name}-${base32Encode(seed)}`;
}
const copy = value => structuredClone(value);
export class NetworkError extends Error {
  constructor(code) { super(code); this.name = 'NetworkError'; this.code = code; }
}
function need(test, code = 'invalid_request') { if (!test) throw new NetworkError(code); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
const time = value => Number.isSafeInteger(value) && value > 0;
function publicOrigin(raw, allowLoopback) {
  let url;
  try { url = new URL(raw); } catch { throw new NetworkError('invalid_invitation'); }
  const testLocal = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  need(testLocal || (url.protocol === 'https:' && /^[a-z0-9-]+\.shares\.zrok\.io$/.test(url.hostname) && (!url.port || url.port === '443')), 'unsupported_gateway');
  need(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'invalid_invitation');
  return url.origin;
}
export function invitationText(origin, id, channelKey, asCode = false) {
  const value = { v: 1, origin, id, channelKey };
  return asCode ? `stn1:${Buffer.from(JSON.stringify(value)).toString('base64url')}` : `${origin}/network/join#${id}.${channelKey}`;
}
export function parseInvitation(text, allowLoopback = false) {
  need(typeof text === 'string' && text.length <= 4096, 'invalid_invitation');
  let value;
  try {
    if (text.trim().startsWith('stn5:')) {
      const parts = SHORT_CODE.exec(text.trim().slice(5));
      need(parts !== null, 'invalid_invitation');
      value = { v: 1, origin: `https://${parts[1]}.shares.zrok.io`, ...deriveFromSeed(base32Decode(parts[2])) };
    }
    else if (text.trim().startsWith('stn1:')) value = JSON.parse(Buffer.from(text.trim().slice(5), 'base64url').toString());
    else {
      const url = new URL(text.trim());
      need(url.pathname === '/network/join' && !url.search && !url.username && !url.password, 'invalid_invitation');
      const parts = url.hash.slice(1).split('.');
      need(parts.length === 2, 'invalid_invitation');
      value = { v: 1, origin: url.origin, id: parts[0], channelKey: parts[1] };
    }
  } catch { throw new NetworkError('invalid_invitation'); }
  need(object(value) && value.v === 1 && HEX_ID.test(value.id) && HEX_KEY.test(value.channelKey), 'invalid_invitation');
  return { v: 1, origin: publicOrigin(value.origin, allowLoopback), id: value.id, channelKey: value.channelKey };
}
export function seal(channelKey, id, direction, value) {
  need(HEX_KEY.test(channelKey) && HEX_ID.test(id));
  const bytes = Buffer.from(JSON.stringify(value));
  need(bytes.length <= 700_000, 'payload_too_large');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(channelKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(`secret-tunnel/network/1/${id}/${direction}`));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { v: 1, id, iv: iv.toString('base64url'), data: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
export function unseal(channelKey, id, direction, packet) {
  try {
    need(object(packet) && packet.v === 1 && packet.id === id && HEX_KEY.test(channelKey));
    need(typeof packet.data === 'string' && packet.data.length <= MAX_WIRE);
    need(typeof packet.iv === 'string' && packet.iv.length === 16 && typeof packet.tag === 'string' && packet.tag.length === 22);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(channelKey, 'hex'), Buffer.from(packet.iv, 'base64url'));
    decipher.setAAD(Buffer.from(`secret-tunnel/network/1/${id}/${direction}`));
    decipher.setAuthTag(Buffer.from(packet.tag, 'base64url'));
    const result = JSON.parse(Buffer.concat([decipher.update(Buffer.from(packet.data, 'base64url')), decipher.final()]).toString());
    need(object(result));
    return result;
  } catch { throw new NetworkError('authentication_failed'); }
}
function validGrant(value) {
  return object(value) && Array.isArray(value.roots) && value.roots.length > 0 && value.roots.length <= 32
    && value.roots.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.startsWith('peer:'))
    && new Set(value.roots).size === value.roots.length && typeof value.writable === 'boolean';
}
function validBindings(grant, bindings) {
  return validGrant(grant) && Array.isArray(bindings) && bindings.length === grant.roots.length
    && new Set(bindings.map(binding => binding?.id)).size === bindings.length
    && bindings.every(binding => object(binding) && grant.roots.includes(binding.id)
      && typeof binding.path === 'string' && binding.path.length > 0 && binding.path.length <= 4096 && !binding.path.includes('\0'));
}
function grantedRoot(upstream, root) {
  return upstream.grant.roots.includes(root.repo_id)
    && upstream.bindings.some(binding => binding.id === root.repo_id && binding.path === root.root);
}
export function validateState(value, allowLoopback = false) {
  need(object(value) && value.version === 1 && HEX_ID.test(value.deviceId), 'invalid_saved_state');
  need(Array.isArray(value.peers) && value.peers.length <= MAX_DEVICES, 'invalid_saved_state');
  need(new Set(value.peers.map(p => p.id)).size === value.peers.length, 'invalid_saved_state');
  for (const peer of value.peers) {
    need(object(peer) && HEX_ID.test(peer.id) && HEX_KEY.test(peer.channelKey) && label(peer.label)
      && ['temporary', 'dependent'].includes(peer.mode) && (peer.expiresAt === null || time(peer.expiresAt)), 'invalid_saved_state');
    need(peer.mode !== 'temporary' || time(peer.expiresAt), 'invalid_saved_state');
  }
  if (value.upstream !== null) {
    const up = value.upstream;
    need(object(up) && HEX_ID.test(up.id) && HEX_KEY.test(up.channelKey) && validBindings(up.grant, up.bindings)
      && (up.expiresAt === null || time(up.expiresAt)), 'invalid_saved_state');
    publicOrigin(up.origin, allowLoopback);
    need(value.peers.length === 0, 'one_hop_only');
  }
  need(Buffer.byteLength(JSON.stringify(value)) <= 30_000, 'state_too_large');
  return copy(value);
}
export async function postPacket(origin, packet, signal) {
  const response = await fetch(`${origin}/network/v1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packet), redirect: 'error', signal
  });
  need(response.ok, 'gateway_unavailable');
  const reader = response.body?.getReader();
  need(reader, 'gateway_unavailable');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; need(size <= MAX_WIRE, 'payload_too_large'); chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { await reader.cancel().catch(() => {}); }
}

export class NetworkHub {
  constructor({ state = null, save = async () => {}, roots = async () => [], execute = async () => { throw new NetworkError('tool_unavailable'); }, send = postPacket, clock = Date.now, allowLoopback = false, pollMs = 15_000, jobMs = 45_000 } = {}) {
    this.state = state === null ? { version: 1, deviceId: randomId(), peers: [], upstream: null } : validateState(state, allowLoopback);
    this.save = save; this.localRoots = roots; this.execute = execute; this.send = send; this.clock = clock;
    this.allowLoopback = allowLoopback; this.pollMs = pollMs; this.jobMs = jobMs;
    this.invites = new Map(); this.live = new Map(); this.jobs = new Map(); this.mutations = Promise.resolve();
    this.closed = false; this.running = false; this.session = 0; this.abort = null; this.lastProblem = null;
  }
  async update(edit) {
    const run = this.mutations.then(async () => {
      need(!this.closed, 'network_stopped');
      const next = copy(this.state); edit(next); validateState(next, this.allowLoopback);
      await this.save(next); this.state = next;
    });
    this.mutations = run.catch(() => {}); return run;
  }
  prune() {
    for (const [id, invite] of this.invites) if (invite.expiresAt <= this.clock()) this.invites.delete(id);
  }
  async create({ origin, mode, label: name = 'Device', profile = null, invitationMs = 15 * 60_000, short = false }) {
    need(!this.closed && !this.state.upstream, 'one_hop_only');
    this.prune(); need(this.invites.size < MAX_DEVICES, 'invitation_capacity');
    need(['temporary', 'dependent', 'profile'].includes(mode) && label(name));
    need([SHORT_MS, 15 * 60_000, DAY].includes(invitationMs), 'invalid_expiry');
    // The short seed is only safe because the window is short. Refusing the
    // combination here means no caller can keep the brevity and drop the limit.
    need(!short || invitationMs === SHORT_MS, 'short_requires_short_expiry');
    if (mode === 'profile') need(object(profile) && Buffer.byteLength(JSON.stringify(profile)) <= 24_000, 'profile_too_large');
    else need(profile === null && this.state.peers.length < MAX_DEVICES, 'device_capacity');
    const safeOrigin = publicOrigin(origin, this.allowLoopback);
    const seed = short ? randomBytes(SHORT_BYTES) : null;
    const { id, channelKey } = seed ? deriveFromSeed(seed) : { id: randomId(), channelKey: randomKey() };
    const expiresAt = this.clock() + invitationMs;
    this.invites.set(id, { id, channelKey, expiresAt, mode, label: name, profile: copy(profile) });
    return {
      id, mode, expiresAt,
      link: invitationText(safeOrigin, id, channelKey),
      code: invitationText(safeOrigin, id, channelKey, true),
      short: seed ? shortInvitationText(safeOrigin, seed) : null,
    };
  }
  async redeem(text, grant, name = 'Device') {
    need(!this.closed && !this.state.upstream && this.state.peers.length === 0, 'already_connected');
    need(label(name));
    const invitation = parseInvitation(text, this.allowLoopback);
    let bindings = [];
    if (grant !== null) {
      need(validGrant(grant), 'invalid_grant');
      const available = new Map((await this.localRoots()).map(root => [root.repo_id, root.root]));
      bindings = grant.roots.map(id => ({ id, path: available.get(id) }));
      need(validBindings(grant, bindings), 'unknown_local_root');
    }
    const reply = await this.rpc(invitation, { op: 'redeem', label: name, grant });
    if (reply.kind === 'profile') {
      need(grant === null && object(reply.profile), 'wrong_invitation_mode');
      return { kind: 'profile', profile: reply.profile };
    }
    need(grant !== null && reply.kind === 'peer' && HEX_ID.test(reply.id) && HEX_KEY.test(reply.channelKey)
      && (reply.expiresAt === null || time(reply.expiresAt)), 'invalid_gateway_response');
    const upstream = { origin: invitation.origin, id: reply.id, channelKey: reply.channelKey, expiresAt: reply.expiresAt, grant: copy(grant), bindings }; 
    await this.update(next => { need(!next.upstream && next.peers.length === 0, 'already_connected'); next.upstream = upstream; });
    this.session++; this.lastProblem = null;
    return { kind: 'peer', expiresAt: reply.expiresAt };
  }
  async rpc(peer, message, signal) {
    const requestId = randomId();
    const payload = seal(peer.channelKey, peer.id, 'request', { ...message, requestId, sentAt: this.clock() });
    const response = await this.send(peer.origin, payload, signal ?? AbortSignal.timeout(25_000));
    const value = unseal(peer.channelKey, peer.id, 'response', response);
    need(value.requestId === requestId, 'response_mismatch');
    if (value.error) throw new NetworkError(typeof value.error === 'string' ? value.error : 'gateway_error');
    return value;
  }
  async edge(packet) {
    need(!this.closed && object(packet) && HEX_ID.test(packet.id), 'authentication_failed');
    this.prune();
    const invite = this.invites.get(packet.id);
    const peer = this.state.peers.find(p => p.id === packet.id);
    const credential = invite ?? peer; need(credential, 'authentication_failed');
    const message = unseal(credential.channelKey, packet.id, 'request', packet);
    need(HEX_ID.test(message.requestId) && time(message.sentAt) && Math.abs(this.clock() - message.sentAt) <= 120_000, 'stale_request');
    let response;
    try {
      if (invite) {
        need(message.op === 'redeem', 'invalid_request');
        need((invite.mode === 'profile' && message.grant === null) || (invite.mode !== 'profile' && validGrant(message.grant)), 'wrong_invitation_mode');
        need(label(message.label));
        // Consume synchronously before awaiting persistence. A lost receipt needs a NEW invite.
        this.invites.delete(invite.id);
        if (invite.mode === 'profile') response = { kind: 'profile', profile: invite.profile };
        else {
          const record = { id: randomId(), channelKey: randomKey(), label: message.label, mode: invite.mode, expiresAt: invite.mode === 'temporary' ? this.clock() + DAY : null };
          await this.update(next => {
            need(!next.upstream && next.peers.length < MAX_DEVICES, 'device_capacity'); next.peers.push(record);
          });
          response = { kind: 'peer', id: record.id, channelKey: record.channelKey, expiresAt: record.expiresAt };
        }
      } else {
        need(peer.expiresAt === null || peer.expiresAt > this.clock(), 'lease_expired');
        let live = this.live.get(peer.id);
        if (!live) { live = { seen: 0, roots: [], nonces: new Map(), wake: null, polling: false }; this.live.set(peer.id, live); }
        for (const [nonce, at] of live.nonces) if (at < this.clock() - 120_000) live.nonces.delete(nonce);
        need(!live.nonces.has(message.requestId), 'replayed_request');
        need(live.nonces.size < 4096, 'request_capacity'); live.nonces.set(message.requestId, this.clock());
        live.seen = this.clock();
        if (message.op === 'poll') {
          need(!live.polling, 'already_polling');
          need(Array.isArray(message.roots) && message.roots.length <= 32, 'invalid_roots');
          for (const root of message.roots) need(object(root) && typeof root.repo_id === 'string' && root.repo_id.length > 0 && root.repo_id.length <= 200 && !root.repo_id.startsWith('peer:') && label(root.display_name), 'invalid_roots');
          live.roots = message.roots.map(r => ({ repo_id: r.repo_id, display_name: r.display_name }));
          live.polling = true;
          try {
            let job = this.nextJob(peer.id);
            if (!job) {
              await new Promise(resolve => {
                const timer = setTimeout(resolve, Math.min(this.pollMs, peer.expiresAt === null ? this.pollMs : Math.max(1, peer.expiresAt - this.clock())));
                live.wake = () => { clearTimeout(timer); resolve(); };
              });
              live.wake = null;
              need(this.state.peers.some(p => p.id === peer.id), 'device_revoked');
              need(peer.expiresAt === null || peer.expiresAt > this.clock(), 'lease_expired');
              job = this.nextJob(peer.id);
            }
            response = { job };
          } finally { live.polling = false; }
        } else if (message.op === 'result') {
          need(HEX_ID.test(message.jobId) && (message.failure === true || object(message.result)), 'invalid_request');
          const pending = this.jobs.get(message.jobId);
          if (pending) {
            need(pending.peerId === peer.id && pending.sent, 'invalid_result');
            clearTimeout(pending.timer); this.jobs.delete(message.jobId);
            if (message.failure) pending.reject(new NetworkError('remote_operation_failed'));
            else pending.resolve(message.result);
          }
          response = { accepted: true }; // Duplicate delivery of a receipt never repeats the operation.
        } else throw new NetworkError('invalid_request');
      }
    } catch (error) { response = { error: error instanceof NetworkError ? error.code : 'network_operation_failed' }; }
    return seal(credential.channelKey, packet.id, 'response', { ...response, requestId: message.requestId });
  }
  nextJob(peerId) {
    for (const [id, job] of this.jobs) if (job.peerId === peerId && !job.sent) {
      job.sent = true; return { id, tool: job.tool, args: job.args };
    }
    return null;
  }
  remoteRoots() {
    const roots = [];
    for (const peer of this.state.peers) {
      if (peer.expiresAt !== null && peer.expiresAt <= this.clock()) continue;
      const live = this.live.get(peer.id); if (!live || this.clock() - live.seen > 45_000) continue;
      for (const root of live.roots) roots.push({ repo_id: `peer:${peer.id}:${root.repo_id}`, display_name: `${peer.label} / ${root.display_name}`, root: `peer://${peer.id}/${root.repo_id}` });
    }
    return roots;
  }
  async route(tool, args) {
    need(READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool), 'remote_tool_not_allowed');
    need(object(args) && typeof args.repo_id === 'string', 'invalid_request');
    const root = this.remoteRoots().find(r => r.repo_id === args.repo_id); need(root, 'device_offline_or_root_unshared');
    need(this.jobs.size < 32, 'request_capacity');
    const [, peerId, ...parts] = args.repo_id.split(':'); const localId = parts.join(':');
    const id = randomId();
    const peer = this.state.peers.find(value => value.id === peerId);
    const deadline = Math.min(this.jobMs, peer.expiresAt === null ? this.jobMs : Math.max(1, peer.expiresAt - this.clock()));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const job = this.jobs.get(id); this.jobs.delete(id);
        reject(new NetworkError(job?.sent ? 'remote_outcome_unknown' : 'device_offline'));
      }, deadline);
      this.jobs.set(id, { peerId, tool, args: { ...args, repo_id: localId }, resolve, reject, timer, sent: false });
      this.live.get(peerId)?.wake?.();
    });
  }
  async runPeer() {
    if (this.running || this.closed) return;
    this.running = true; const generation = this.session; let receipt = null; let failures = 0;
    try {
      while (!this.closed && this.state.upstream && generation === this.session) {
        const upstream = copy(this.state.upstream);
        if (upstream.expiresAt !== null && upstream.expiresAt <= this.clock()) { this.lastProblem = 'lease_expired'; break; }
        this.abort = new AbortController();
        const timeout = setTimeout(() => this.abort?.abort(), 25_000);
        try {
          if (receipt) {
            await this.rpc(upstream, receipt, this.abort.signal); receipt = null;
          } else {
            const roots = (await this.localRoots()).filter(r => grantedRoot(upstream, r));
            const response = await this.rpc(upstream, { op: 'poll', roots: roots.map(r => ({ repo_id: r.repo_id, display_name: r.display_name })) }, this.abort.signal);
            if (response.job) {
              const job = response.job;
              need(HEX_ID.test(job.id) && typeof job.tool === 'string' && object(job.args), 'invalid_job');
              // Recheck CURRENT local grants, roots, expiry and session after the long poll.
              const active = this.state.upstream;
              need(active && generation === this.session && active.id === upstream.id, 'device_revoked');
              need(active.expiresAt === null || active.expiresAt > this.clock(), 'lease_expired');
              const available = (await this.localRoots()).some(r => r.repo_id === job.args.repo_id && grantedRoot(active, r));
              try {
                need(active.grant.roots.includes(job.args.repo_id) && available, 'root_not_granted');
                need(READ_TOOLS.has(job.tool) || (active.grant.writable && WRITE_TOOLS.has(job.tool)), 'remote_tool_not_allowed');
                const result = await this.execute(job.tool, job.args, active.bindings.find(binding => binding.id === job.args.repo_id)?.path);
                need(Buffer.byteLength(JSON.stringify(result)) <= 600_000, 'payload_too_large');
                receipt = { op: 'result', jobId: job.id, result };
              } catch { receipt = { op: 'result', jobId: job.id, failure: true }; }
            }
          }
          failures = 0; this.lastProblem = null;
        } catch (error) {
          this.lastProblem = error instanceof NetworkError ? error.code : 'gateway_unavailable';
          if (this.lastProblem === 'lease_expired') break;
          failures++; // Retain receipt, NEVER re-run a dispatched write after a transport error.
        } finally { clearTimeout(timeout); this.abort = null; }
        if (failures && !this.closed && generation === this.session) await new Promise(resolve => setTimeout(resolve, Math.min(15_000, 250 * 2 ** Math.min(failures, 6))));
      }
    } finally { this.running = false; }
  }
  async revoke(id) {
    need(HEX_ID.test(id));
    if (this.invites.delete(id)) return;
    await this.update(next => { next.peers = next.peers.filter(p => p.id !== id); });
    this.live.get(id)?.wake?.(); this.live.delete(id);
    for (const [jobId, job] of this.jobs) if (job.peerId === id) { clearTimeout(job.timer); job.reject(new NetworkError(job.sent ? 'remote_outcome_unknown' : 'device_revoked')); this.jobs.delete(jobId); }
  }
  async leave() {
    await this.update(next => { next.upstream = null; }); this.session++; this.abort?.abort();
  }
  status() {
    this.prune();
    return { version: 1, deviceId: this.state.deviceId, upstream: this.state.upstream ? { origin: this.state.upstream.origin, expiresAt: this.state.upstream.expiresAt, grant: copy(this.state.upstream.grant), problem: this.lastProblem } : null,
      peers: this.state.peers.map(p => ({ id: p.id, label: p.label, mode: p.mode, expiresAt: p.expiresAt, online: (this.live.get(p.id)?.seen ?? 0) > this.clock() - 45_000 && (p.expiresAt === null || p.expiresAt > this.clock()) })),
      invitations: [...this.invites.values()].map(p => ({ id: p.id, mode: p.mode, expiresAt: p.expiresAt })) };
  }
  close() {
    this.closed = true; this.session++; this.abort?.abort(); this.invites.clear();
    for (const live of this.live.values()) live.wake?.();
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(new NetworkError(job.sent ? 'remote_outcome_unknown' : 'network_stopped')); }
    this.jobs.clear();
  }
}
