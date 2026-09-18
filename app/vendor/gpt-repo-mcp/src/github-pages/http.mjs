import https from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { VerificationError, MAX_BODY_BYTES, apiPath, validateRequest } from './core.mjs';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4]]) blocked.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [ip, bits] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]]) blockedV6.addSubnet(ip,bits,'ipv6');
export function isPublicAddress(address) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  if (isIP(address) === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}
export function publicLookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, answers) => {
    if (error || !answers?.length || answers.some(a => !isPublicAddress(a.address))) {
      callback(new VerificationError('DNS_NOT_PUBLIC', 'The destination did not resolve exclusively to public addresses.'));
      return;
    }
    // The vetted addresses are handed to the actual socket, not resolved a second time.
    if (options?.all) callback(null, answers);
    else {
      const answer = answers.find(a => !options?.family || a.family === options.family);
      if (!answer) callback(new VerificationError('DNS_NOT_PUBLIC', 'No approved address for the requested address family.'));
      else callback(null, answer.address, answer.family);
    }
  });
}
export function getPublicHttps(urlValue, { json = false, signal, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlValue); } catch { reject(new VerificationError('UNSAFE_URL', 'Invalid URL.')); return; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(url.hostname) ||
        !/^[a-z0-9.-]+$/.test(url.hostname) || url.hostname.endsWith('.')) {
      reject(new VerificationError('UNSAFE_URL', 'Only public HTTPS hostnames are supported.')); return;
    }
    if (signal?.aborted) { reject(new VerificationError('CANCELED', 'Verification canceled.')); return; }
    let settled = false;
    let request;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => {
      const error = new VerificationError('CANCELED', 'Verification canceled.');
      finish(error); request?.destroy(error);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const headers = { 'User-Agent': 'SecretTunnel-PagesVerifier/1', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', Accept: json ? 'application/vnd.github+json' : '*/*' };
    if (json) headers['X-GitHub-Api-Version'] = '2026-03-10';
    request = https.get(url, { headers, lookup: publicLookup, agent: false, rejectUnauthorized: true }, response => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        // Never follow Location, and never echo remote error bodies or response headers.
        response.destroy(); finish(null, { status, body: null }); return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        const error = new VerificationError('UNSUPPORTED_ENCODING', 'Compressed responses are not accepted by this bounded verifier.');
        response.destroy(); finish(error); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          const error = new VerificationError('RESPONSE_TOO_LARGE', 'Response exceeded the verification bound.');
          response.destroy(error); request.destroy(error); finish(error); return;
        }
        chunks.push(chunk);
      });
      response.on('aborted', () => finish(new VerificationError('READ_INTERRUPTED', 'Response was interrupted.')));
      response.on('error', () => finish(new VerificationError('READ_FAILED', 'Response could not be read.')));
      response.on('end', () => {
        const data = Buffer.concat(chunks);
        if (!response.complete) { finish(new VerificationError('READ_INTERRUPTED', 'Incomplete response.')); return; }
        if (!json) { finish(null, { status, body: data }); return; }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
          finish(null, { status, body: JSON.parse(text) });
        } catch { finish(new VerificationError('INVALID_RESPONSE', 'Expected bounded UTF-8 JSON.')); }
      });
    });
    request.on('error', error => finish(error instanceof VerificationError ? error : new VerificationError('NETWORK_ERROR', 'HTTPS request failed.')));
    timer = setTimeout(() => {
      const error = new VerificationError('TIMEOUT', 'HTTPS verification deadline exceeded.');
      finish(error); request.destroy(error);
    }, Math.min(Math.max(timeoutMs, 1), 15000));
    timer.unref();
    if (signal?.aborted) cancel();
  });
}

export function createPublicReaders(input, { signal, transport = getPublicHttps } = {}) {
  const request = validateRequest(input);
  const routes = new Set(['repository', 'commit', 'pages', 'deployment', 'builds',
    ...(request.branch ? ['branch'] : []), ...(request.workflow_id ? ['workflow'] : [])].map(kind => apiPath(request, kind)));
  return {
    origin: 'public_https',
    readApi(path) {
      if (!routes.has(path)) throw new VerificationError('UNAPPROVED_ROUTE', 'This endpoint is not part of the bound inspection.');
      return transport(`https://api.github.com${path}`, { json: true, signal });
    },
    // inspectPages owns the verified Pages origin/base check before using this reader.
    readSite(url) { return transport(url, { json: false, signal }); }
  };
}
