// Regression gates for the pieces the website-publication workflow added:
// an explicit repository visibility on repo_ensure, a custom domain on
// pages_ensure, and the rule that the domain this app configured for the bound
// repository — and no other origin — may be verified as the live site.
//
// Offline by design: node:test, node:assert and a disposable loopback broker.
// No GitHub, no Git, no desktop, no network reads of any real site.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBrokerClient, validateBrokerInput, BrokerClientError }
  from '../../vendor/gpt-repo-mcp/src/github-broker-client.mjs';
import { inspectPages, apiPath } from '../../vendor/gpt-repo-mcp/src/github-pages/core.mjs';
import { FIXTURE_CREDENTIAL, ENV_KEYS } from './fixtures.mjs';

const SHA = 'a'.repeat(40);
const DOMAIN = 'custom.example.org';

/* ------------------------------------------------------ request validation */

test('repo_ensure carries an explicit visibility and refuses anything else', () => {
  assert.deepEqual(validateBrokerInput('/github/repo_ensure', {}), {});
  assert.deepEqual(validateBrokerInput('/github/repo_ensure', { name: 'site' }), { name: 'site' });
  for (const visibility of ['public', 'private']) {
    assert.deepEqual(validateBrokerInput('/github/repo_ensure', { name: 'site', visibility }),
      { name: 'site', visibility });
  }
  // Visibility alone is legitimate: the folder name supplies the repository name.
  assert.deepEqual(validateBrokerInput('/github/repo_ensure', { visibility: 'public' }), { visibility: 'public' });
  for (const rejected of ['internal', 'PUBLIC', '', true, null, ['public']]) {
    assert.throws(() => validateBrokerInput('/github/repo_ensure', { name: 'site', visibility: rejected }),
      BrokerClientError, `visibility ${JSON.stringify(rejected)} must be refused`);
  }
  assert.throws(() => validateBrokerInput('/github/repo_ensure', { name: 'site', private: false }), BrokerClientError);
});

test('pages_ensure carries a custom domain and only enforces HTTPS for one', () => {
  assert.deepEqual(validateBrokerInput('/github/pages_ensure', {}), {});
  assert.deepEqual(validateBrokerInput('/github/pages_ensure', { domain: DOMAIN, httpsEnforced: true }),
    { domain: DOMAIN, httpsEnforced: true });
  assert.deepEqual(validateBrokerInput('/github/pages_ensure', { domain: 'creations-of-ra.com' }),
    { domain: 'creations-of-ra.com' });
  // HTTPS with no domain would configure nothing, so it never reaches the desktop.
  assert.throws(() => validateBrokerInput('/github/pages_ensure', { httpsEnforced: true }), BrokerClientError);
  for (const rejected of ['example', 'Example.com', 'https://example.com', 'example.com/path',
    'example.com.', '-example.com', 'exa mple.com', 42, true, ['example.com']]) {
    assert.throws(() => validateBrokerInput('/github/pages_ensure', { domain: rejected }),
      BrokerClientError, `domain ${JSON.stringify(rejected)} must be refused`);
  }
  assert.throws(() => validateBrokerInput('/github/pages_ensure', { cname: DOMAIN }), BrokerClientError);
});

/* ------------------------------------------------------- response projection */

async function brokerReturning(t, payload) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const body = Buffer.from(JSON.stringify(payload));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
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

test('the configured domain and HTTPS state survive back to the caller', async t => {
  const client = await brokerReturning(t, {
    workflowPath: '.github/workflows/pages.yml', workflowWritten: true,
    pages: 'enabled', branch: 'main', domain: DOMAIN, httpsEnforced: false,
    note: 'HTTPS is still being issued.'
  });
  assert.deepEqual(await client.call('/github/pages_ensure', { domain: DOMAIN, httpsEnforced: true }), {
    workflowPath: '.github/workflows/pages.yml', workflowWritten: true, pages: 'enabled',
    branch: 'main', domain: DOMAIN, httpsEnforced: false, note: 'HTTPS is still being issued.'
  });
});

test('a bound custom domain reaches the verifier, and a malformed one does not', async t => {
  const context = {
    repository: 'example/site', repositoryId: 42, commit: SHA, branch: 'main',
    pagesDomain: DOMAIN, workflowPath: '.github/workflows/pages.yml',
    // GitHub will not serve this record without a credential, so the desktop
    // reads it and hands it over; the verifier never authenticates.
    pagesSite: { buildType: 'workflow', htmlUrl: 'https://' + DOMAIN + '/', cname: DOMAIN,
      httpsEnforced: true, sourceBranch: null, sourcePath: null }
  };
  const client = await brokerReturning(t, context);
  assert.deepEqual(await client.call('/github/pages_context', {}), context);

  for (const broken of [{ pagesDomain: 'https://evil.example/' }, { workflowPath: '../../etc/passwd' },
    { pagesSite: { buildType: 'workflow', htmlUrl: 'ftp://elsewhere/', cname: null, httpsEnforced: false, sourceBranch: null, sourcePath: null } }]) {
    const hostile = await brokerReturning(t, { ...context, ...broken });
    await assert.rejects(() => hostile.call('/github/pages_context', {}),
      error => error instanceof BrokerClientError && error.code === 'broker_schema',
      `${JSON.stringify(broken)} must be refused`);
  }
});

/* --------------------------------------------- Actions deployment evidence */

// GitHub answers /pages/deployments/<commit> with an empty status for an
// Actions-built site — for any commit, including one that does not exist — so
// that read carries no evidence. The deploying run for the exact commit does.
function workflowFixture(overrides = {}) {
  const request = {
    repository: 'example/site', repository_id: 42, commit: SHA, branch: 'main',
    workflow_id: 'pages.yml',
    live: { assertion: { kind: 'contains', value: '<html' } }
  };
  const run = {
    id: 100, workflow_id: 7, path: '.github/workflows/pages.yml', repository: { id: 42 },
    head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed',
    conclusion: 'success', run_attempt: 1, created_at: '2026-09-17T00:00:00Z'
  };
  const responses = {
    repository: { status: 200, body: { id: 42, full_name: 'example/site' } },
    commit: { status: 200, body: { sha: SHA } },
    branch: { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } } },
    pages: { status: 200, body: { build_type: 'workflow', html_url: 'https://example.github.io/site/' } },
    deployment: { status: 200, body: { status: '' } },
    builds: { status: 200, body: [] },
    workflow: { status: 200, body: { total_count: 1, workflow_runs: [{ ...run, ...overrides }] } }
  };
  const readers = {
    origin: 'injected_provider',
    readApi: async path => responses[Object.keys(responses).find(kind => {
      try { return apiPath(request, kind) === path; } catch { return false; } })],
    readSite: async () => ({ status: 200, body: '<html><body>site</body></html>' })
  };
  return { request, responses, readers, run: () => inspectPages(request, readers) };
}

test('the deploying run for the exact commit stands in for the status GitHub omits', async () => {
  const f = workflowFixture();
  const report = await f.run();
  assert.equal(report.deployment.state, 'succeeded');
  assert.equal(report.deployment.evidence, 'actions_workflow_run_exact_commit');
  assert.ok(report.warnings.includes('PAGES_DEPLOYMENT_STATUS_NOT_PUBLISHED'));
  assert.equal(report.verified, true);
});

test('the run must belong to this workflow, commit, branch and repository', async () => {
  for (const wrong of [{ path: '.github/workflows/lint.yml' }, { head_sha: 'b'.repeat(40) },
    { head_branch: 'other' }, { repository: { id: 99 } }, { event: 'pull_request' }]) {
    const report = await workflowFixture(wrong).run();
    assert.equal(report.verified, false, `${JSON.stringify(wrong)} must not verify`);
    assert.notEqual(report.deployment.state, 'succeeded');
  }
});

test('a failed or running deploy is reported, never treated as published', async () => {
  const failed = await workflowFixture({ conclusion: 'failure' }).run();
  assert.equal(failed.deployment.state, 'failed');
  assert.equal(failed.outcome, 'failed');
  const running = await workflowFixture({ status: 'in_progress', conclusion: null }).run();
  assert.equal(running.outcome, 'pending');
});

test('without a run to stand in, the omitted status is not success', async () => {
  const f = workflowFixture();
  f.responses.workflow = { status: 200, body: { total_count: 0, workflow_runs: [] } };
  const report = await f.run();
  assert.equal(report.deployment.state, 'not_published');
  assert.equal(report.verified, false);
});

/* ----------------------------------------------------------- origin approval */

// The verifier is the enforcement point. It is given only what the desktop
// binding says, so a site GitHub reports on some other host stays refused.
function pagesFixture(htmlUrl) {
  const request = {
    repository: 'example/site', repository_id: 42, commit: SHA, branch: 'main',
    live: { assertion: { kind: 'contains', value: '<html' } }
  };
  const responses = {
    repository: { status: 200, body: { id: 42, full_name: 'example/site' } },
    commit: { status: 200, body: { sha: SHA } },
    branch: { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } } },
    pages: { status: 200, body: { build_type: 'workflow', html_url: htmlUrl, cname: DOMAIN, https_enforced: true } },
    deployment: { status: 200, body: { status: 'succeed' } },
    builds: { status: 200, body: [] }
  };
  const fetched = [];
  const readers = {
    origin: 'injected_provider',
    readApi: async path => responses[Object.keys(responses).find(kind => {
      try { return apiPath(request, kind) === path; } catch { return false; } })],
    readSite: async url => { fetched.push(url); return { status: 200, body: '<html><body>site</body></html>' }; }
  };
  return { request, readers, fetched };
}

test('the domain Secret Tunnel configured for this repository is a verifiable site', async () => {
  const f = pagesFixture(`https://${DOMAIN}/`);
  f.request.approved_site_origin = `https://${DOMAIN}`;
  const report = await inspectPages(f.request, f.readers);
  assert.equal(report.verified, true);
  assert.deepEqual(f.fetched, [`https://${DOMAIN}/`]);
  // GitHub's own view of the domain is reported, so a caller can tell a
  // configured-but-unreachable domain from one that was never configured.
  assert.equal(report.pages.cname, DOMAIN);
  assert.equal(report.pages.https_enforced, true);
});

test('any other origin stays refused even when GitHub reports it', async () => {
  for (const reported of ['https://attacker.example/', 'https://sub.custom.example.org/', `http://${DOMAIN}/`]) {
    const f = pagesFixture(reported);
    f.request.approved_site_origin = `https://${DOMAIN}`;
    const report = await inspectPages(f.request, f.readers);
    assert.equal(report.verified, false, `${reported} must not verify`);
    assert.equal(f.fetched.length, 0, `${reported} must not be fetched`);
  }
});

test('without a configured domain a custom origin is not fetched at all', async () => {
  const f = pagesFixture(`https://${DOMAIN}/`);
  const report = await inspectPages(f.request, f.readers);
  assert.ok(report.warnings.includes('SITE_APPROVAL_REQUIRED'));
  assert.equal(f.fetched.length, 0);
  assert.equal(report.verified, false);
});
