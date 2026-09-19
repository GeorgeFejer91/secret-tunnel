// Regression gates for the deliberate repository retarget: the one request
// that moves an already-bound folder from one GitHub repository to another.
//
// github_repo_ensure refuses to retarget on purpose, so this request exists to
// say "yes, really, move it" - and the whole value of it is that it says which
// binding it believes it is replacing. These tests hold the client to that: a
// retarget must name both ends, must not be readable as a request to move
// anywhere, and must not accept a result the desktop did not really return.
//
// Offline by design: node:test, node:assert and a disposable loopback broker.
// No GitHub, no Git, no desktop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBrokerClient, validateBrokerInput, BrokerClientError }
  from '../../vendor/gpt-repo-mcp/src/github-broker-client.mjs';
import { FIXTURE_CREDENTIAL, ENV_KEYS } from './fixtures.mjs';

const REQUEST = {
  expectedOwner: 'fixture-owner', expectedRepo: 'old-repo',
  targetOwner: 'fixture-owner', targetRepo: 'new-repo'
};
const RESULT = {
  previousOwner: 'fixture-owner', previousRepo: 'old-repo', previousRepositoryId: 41,
  previousOrigin: 'https://github.com/fixture-owner/old-repo.git', previousBranch: 'main',
  owner: 'fixture-owner', repo: 'new-repo', repositoryId: 42,
  origin: 'https://github.com/fixture-owner/new-repo.git', branch: 'main'
};

/* ------------------------------------------------------ request validation */

test('a retarget must state the binding it replaces and the one it wants', () => {
  assert.deepEqual(validateBrokerInput('/github/repo_rebind', REQUEST), REQUEST);
  assert.deepEqual(validateBrokerInput('/github/repo_rebind', { ...REQUEST, branch: 'gh-pages' }),
    { ...REQUEST, branch: 'gh-pages' });

  // Every identifying field is required. A retarget missing one end is not a
  // smaller request, it is an ambiguous one.
  for (const field of ['expectedOwner', 'expectedRepo', 'targetOwner', 'targetRepo']) {
    const partial = { ...REQUEST };
    delete partial[field];
    assert.throws(() => validateBrokerInput('/github/repo_rebind', partial),
      BrokerClientError, `a request without ${field} must be refused`);
  }
});

test('only real GitHub owner and repository names are forwarded', () => {
  for (const rejected of ['', '.', '..', '-leading', 'has space', 'owner/repo', 'a'.repeat(101), 42, null, ['name']]) {
    assert.throws(() => validateBrokerInput('/github/repo_rebind', { ...REQUEST, targetRepo: rejected }),
      BrokerClientError, `target ${JSON.stringify(rejected)} must be refused`);
  }
  for (const rejected of ['', 'main branch', 'feature~1', 'refs:heads', 'a'.repeat(201), 42, null]) {
    assert.throws(() => validateBrokerInput('/github/repo_rebind', { ...REQUEST, branch: rejected }),
      BrokerClientError, `branch ${JSON.stringify(rejected)} must be refused`);
  }
  // Nothing outside the contract reaches the desktop, including fields that
  // would look plausible next to the real ones.
  assert.throws(() => validateBrokerInput('/github/repo_rebind', { ...REQUEST, force: true }), BrokerClientError);
  assert.throws(() => validateBrokerInput('/github/repo_rebind', { ...REQUEST, repositoryId: 42 }), BrokerClientError);
});

test('retargeting a folder to the repository it is already bound to is refused', () => {
  assert.throws(() => validateBrokerInput('/github/repo_rebind',
    { expectedOwner: 'fixture-owner', expectedRepo: 'same', targetOwner: 'fixture-owner', targetRepo: 'same' }),
  BrokerClientError, 'a no-op retarget is a mistake, not a request');
  // Case is not identity on GitHub, so the same repository spelled differently
  // is still the same repository.
  assert.throws(() => validateBrokerInput('/github/repo_rebind',
    { expectedOwner: 'Fixture-Owner', expectedRepo: 'Same', targetOwner: 'fixture-owner', targetRepo: 'same' }),
  BrokerClientError);
});

/* ----------------------------------------------------- response projection */

async function brokerReturning(t, payload, status = 200) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const body = Buffer.from(JSON.stringify(payload));
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
      response.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => done());
  }));
  return createBrokerClient({
    [ENV_KEYS.url]: `http://127.0.0.1:${server.address().port}/`,
    [ENV_KEYS.credential]: FIXTURE_CREDENTIAL
  });
}

test('the before and after binding survive back to the caller', async t => {
  const client = await brokerReturning(t, RESULT);
  assert.deepEqual(await client.call('/github/repo_rebind', REQUEST), RESULT);
});

test('a folder that never had an origin reports one afterwards', async t => {
  const client = await brokerReturning(t, { ...RESULT, previousOrigin: null, previousRepositoryId: null });
  const result = await client.call('/github/repo_rebind', REQUEST);
  assert.equal(result.previousOrigin, null);
  assert.equal(result.previousRepositoryId, null);
  assert.equal(result.origin, 'https://github.com/fixture-owner/new-repo.git');
});

test('a result that is not a real retarget is refused rather than reported', async t => {
  for (const broken of [
    { origin: 'https://github.com/fixture-owner/new-repo.git?token=abc' },
    { origin: 'https://user:secret@github.com/fixture-owner/new-repo.git' },
    { origin: 'git@github.com:fixture-owner/new-repo.git' },
    { previousOrigin: 'https://evil.example/fixture-owner/old-repo.git' },
    { repositoryId: 0 },
    { repositoryId: '42' },
    { owner: 42 }
  ]) {
    const client = await brokerReturning(t, { ...RESULT, ...broken });
    await assert.rejects(() => client.call('/github/repo_rebind', REQUEST),
      error => error instanceof BrokerClientError && error.code === 'broker_schema',
      `${JSON.stringify(broken)} must be refused`);
  }
});

test('a stale expected binding comes back as the desktop worded it', async t => {
  const client = await brokerReturning(t,
    { error: { code: 'binding_mismatch', message: 'This folder is bound to fixture-owner/other-repo.' } }, 400);
  await assert.rejects(() => client.call('/github/repo_rebind', REQUEST),
    error => error instanceof BrokerClientError
      && error.code === 'binding_mismatch'
      // Nothing was carried out, so this is a refusal and not an unknown outcome.
      && error.outcome === 'refused');
});
