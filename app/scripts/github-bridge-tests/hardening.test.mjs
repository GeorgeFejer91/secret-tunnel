import test from 'node:test';
import assert from 'node:assert/strict';
import { githubReceiptSchema, projectOperationReceipt } from '../../vendor/gpt-repo-mcp/src/github-contract.mjs';

const before = 'a'.repeat(40);
const after = 'b'.repeat(40);
function receipt(overrides = {}) {
  return { schemaVersion: 1, operationId: `plan-${'c'.repeat(32)}`, instanceId: 'd'.repeat(32),
    action: 'commit', state: 'succeeded', phase: 'complete', startedAtSecs: 1, updatedAtSecs: 2,
    commit: { beforeHead: before, afterHead: after, committedPaths: ['notes.txt'] },
    createdRepository: null, setup: [], errorCode: null, ...overrides };
}
function publication() {
  const value = receipt(); value.action = 'commit_push';
  value.commit.pushed = { remote: 'origin', branch: 'main', pushedHead: after,
    verifiedRemoteHead: after, repository: 'fixture/repository' };
  return value;
}
function creation() {
  return receipt({ action: 'create_repository', commit: null, createdRepository: {
    fullName: 'fixture/repository', htmlUrl: 'https://github.com/fixture/repository',
    cloneUrl: 'https://github.com/fixture/repository.git', private: true, defaultBranch: 'main' } });
}

test('a local commit returns its durable identity and commit evidence', () => {
  assert.deepEqual(projectOperationReceipt(receipt()), receipt());
});
test('verified publication evidence survives projection', () => {
  const value = publication();
  assert.deepEqual(projectOperationReceipt(value).commit.pushed, value.commit.pushed);
});
test('a push reporting another HEAD is refused', () => {
  const value = publication(); value.commit.pushed.pushedHead = before;
  assert.throws(() => projectOperationReceipt(value), /matching verified/);
});
test('a push with no verified remote tip is not reported as success', () => {
  const value = publication(); value.commit.pushed.verifiedRemoteHead = null;
  assert.throws(() => projectOperationReceipt(value), /matching verified/);
});
test('dropping the entire push receipt cannot manufacture publication success', () => {
  const value = publication(); delete value.commit.pushed;
  assert.throws(() => projectOperationReceipt(value), /matching verified/);
});
test('a known commit plus an unsuccessful publication remains partial', () => {
  const value = receipt({ action: 'commit_push', state: 'partial', phase: 'publishing', errorCode: 'git_failed' });
  const result = projectOperationReceipt(value);
  assert.equal(result.state, 'partial'); assert.equal(result.commit.afterHead, after);
});
test('unknown state preserves uncertainty without requiring invented side effects', () => {
  const value = receipt({ state: 'unknown', commit: null, phase: 'committing', errorCode: 'interrupted_reconcile_required' });
  assert.equal(projectOperationReceipt(value).state, 'unknown');
});
test('repository creation has its own result and no fictional local commit', () => {
  const value = creation(); assert.deepEqual(projectOperationReceipt(value), value);
});
test('a public repository cannot satisfy a private creation approval', () => {
  const value = creation(); value.createdRepository.private = false;
  assert.throws(() => projectOperationReceipt(value), /private repository/);
});
for (const url of ['https://user@github.com/fixture/repository', 'https://github.com.evil.invalid/fixture/repository',
  'https://github.com/fixture/repository?credential=example', 'file:///tmp/repository']) {
  test(`creation rejects an unsafe repository URL: ${url}`, () => {
    const value = creation(); value.createdRepository.cloneUrl = url;
    assert.throws(() => projectOperationReceipt(value));
  });
}
test('old unversioned outcomes fail closed instead of resembling new receipts', () => {
  assert.throws(() => projectOperationReceipt(receipt().commit));
});
test('an unsupported contract version fails closed', () => {
  assert.throws(() => projectOperationReceipt(receipt({ schemaVersion: 2 })));
});
test('unknown broker fields are not forwarded', () => {
  const value = receipt({ privateInternalDetail: 'not public' });
  value.commit.internalDetail = 'not public';
  const result = projectOperationReceipt(value);
  assert.equal(Object.hasOwn(result, 'privateInternalDetail'), false);
  assert.equal(Object.hasOwn(result.commit, 'internalDetail'), false);
});
test('a result cannot be both succeeded and contain an error code', () => {
  assert.throws(() => projectOperationReceipt(receipt({ errorCode: 'git_failed' })));
});
test('receipt time cannot run backwards', () => {
  assert.throws(() => projectOperationReceipt(receipt({ updatedAtSecs: 0 })));
});
test('result paths remain bounded', () => {
  const value = receipt(); value.commit.committedPaths = Array.from({ length: 51 }, (_, i) => `f${i}`);
  assert.throws(() => projectOperationReceipt(value));
});
test('invalid IDs and unbounded error details are refused', () => {
  assert.throws(() => projectOperationReceipt(receipt({ operationId: '../another-operation' })));
  assert.throws(() => projectOperationReceipt(receipt({ errorCode: 'private path with spaces' })));
});
test('public JSON schema advertises version and nested publication evidence', () => {
  assert.equal(githubReceiptSchema.properties.schemaVersion.const, 1);
  assert.ok(githubReceiptSchema.properties.commit.anyOf[0].properties.pushed);
});

function expectedTarget() {
  return { workspaceFingerprint: 'fixture', settingsRevision: 123,
    localHead: before, branch: 'main', remoteTip: before, contentDigest: null, accountLogin: null,
    publication: { remote: 'origin', url: 'https://github.com/fixture/repository.git', repository: 'fixture/repository', branch: 'main' } };
}
test('an interrupted publication retains its approved destination for recovery', () => {
  const value = receipt({ action: 'commit_push', state: 'partial', phase: 'publishing',
    errorCode: 'push_unverified', expected: expectedTarget() });
  const result = projectOperationReceipt(value);
  assert.equal(result.expected.publication.url, 'https://github.com/fixture/repository.git');
  assert.equal(result.expected.localHead, before);
  assert.equal(Object.hasOwn(result.expected, 'settingsRevision'), false, 'private u64 revision is not a JavaScript approval input');
});
test('success for another destination cannot satisfy this approval', () => {
  const value = publication(); value.expected = expectedTarget();
  value.expected.publication.repository = 'other/repository';
  assert.throws(() => projectOperationReceipt(value), /approved destination/);
});
test('a commit receipt must match the source HEAD that was approved', () => {
  const value = publication(); value.expected = expectedTarget();
  value.expected.localHead = 'e'.repeat(40);
  assert.throws(() => projectOperationReceipt(value), /approved source/);
});
