#!/usr/bin/env node
import { open, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { inspectPages, validateRequest, exitCode, VerificationError, MAX_BODY_BYTES, MAX_REQUEST_BYTES, apiPath } from './core.mjs';
import { createPublicReaders } from './http.mjs';

export async function readJsonFile(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new VerificationError('INVALID_INPUT_FILE', 'Input must be a bounded regular JSON file.');
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.size > maxBytes) throw new VerificationError('INPUT_CHANGED', 'Input file changed during inspection.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new VerificationError('INPUT_TOO_LARGE', 'Input exceeded its bound.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { await file.close(); }
}
export function parseArgs(args) {
  const result = { live: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' && args.length === 1) return { help: true };
    if (arg === '--live' && !result.live) result.live = true;
    else if (['--request', '--snapshot'].includes(arg)) {
      const key = arg.slice(2);
      if (result[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new VerificationError('USAGE', 'Invalid or duplicate file option.');
      result[key] = args[++i];
    } else throw new VerificationError('USAGE', 'Unknown or duplicate option.');
  }
  if (!result.request || result.live === Boolean(result.snapshot)) throw new VerificationError('USAGE', 'Supply --request FILE and exactly one of --live or --snapshot FILE.');
  return result;
}
export const HELP = `Secret Tunnel Pages inspector (GET-only; no login, push, or deployment)\n\n  node app/scripts/github-pages/inspect.mjs --request request.json --live\n  node app/scripts/github-pages/inspect.mjs --request request.json --snapshot evidence.json\n\nRequest: repository, numeric repository_id, exact commit; optional branch, workflow_id,\napproved_site_origin and live assertion. See app/scripts/github-pages/README.md.\n\nExit: 0 live requested checks verified; 1 observed failure; 2 pending/unverified/replay;\n3 invalid input or verifier error. Stdout is JSON. No files are written.\n`;

export async function main(args, { stdout = text => process.stdout.write(text) } = {}) {
  try {
    const options = parseArgs(args);
    if (options.help) { stdout(HELP); return 0; }
    const request = validateRequest(await readJsonFile(options.request, MAX_REQUEST_BYTES));
    let readers;
    if (options.snapshot) {
      const fixture = await readJsonFile(options.snapshot, 4 * MAX_BODY_BYTES);
      if (!fixture || fixture.schema_version !== 1 || !fixture.api || typeof fixture.api !== 'object' || Array.isArray(fixture.api)) throw new VerificationError('INVALID_SNAPSHOT', 'Invalid snapshot envelope.');
      readers = {
        origin: 'supplied_snapshot',
        readApi: async path => {
          if (!Object.prototype.hasOwnProperty.call(fixture.api, path)) throw new VerificationError('SNAPSHOT_MISSING', 'The snapshot does not contain this read.');
          return fixture.api[path];
        },
        readSite: async url => {
          if (!fixture.site || fixture.site.url !== url) throw new VerificationError('SNAPSHOT_MISSING', 'No exact site response in snapshot.');
          return fixture.site.response;
        }
      };
      // Validate any requested optional paths before interpreting evidence.
      apiPath(request, 'repository');
    } else readers = createPublicReaders(request, { signal: AbortSignal.timeout(60000) });
    const report = await inspectPages(request, readers);
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    return exitCode(report);
  } catch (error) {
    // Paths, remote messages, and file contents may contain credentials; do not echo them.
    const code = error instanceof VerificationError ? error.code : 'VERIFIER_ERROR';
    stdout(`${JSON.stringify({ schema_version: 1, kind: 'secret-tunnel.github-pages.error', code, verified: false })}\n`);
    return 3;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
