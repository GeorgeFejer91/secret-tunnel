import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { projectOperationReceipt } from '../vendor/gpt-repo-mcp/src/github-contract.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--fixture') {
    throw new Error('Usage: node scripts/verify-github-contract.mjs --fixture <fresh Rust-produced JSON file>');
  }
  const path = resolve(args[1]);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 65536) throw new Error('Fixture must be a bounded regular JSON file.');
  const bytes = await readFile(path);
  const receipt = projectOperationReceipt(JSON.parse(bytes.toString('utf8')));
  if (receipt.action !== 'commit_push' || receipt.state !== 'succeeded'
    || receipt.commit?.pushed?.verifiedRemoteHead !== receipt.commit?.afterHead) {
    throw new Error('The native fixture must include a verified commit-and-push outcome.');
  }
  console.log(JSON.stringify({ result: 'passed', check: 'supplied_rust_fixture_matches_javascript_contract',
    schemaVersion: receipt.schemaVersion, sha256: createHash('sha256').update(bytes).digest('hex'),
    note: 'Pair this result with the native test log that generated this fresh fixture. This command does not compile or run Rust.' }, null, 2));
}
main().catch(() => {
  console.error(JSON.stringify({ result: 'failed', check: 'rust_javascript_contract',
    message: 'Missing, invalid or incompatible fixture. Run the native fixture test and preserve its evidence.' }));
  process.exitCode = 1;
});
