// Shared synthetic fixtures for the GitHub bridge verification suites.
//
// Extracted from client.test.mjs and sdk.test.mjs, which held byte-identical copies of
// everything below. No behaviour change: both suites produce the same payloads they did
// before. Imported only by those two files; it is not a test and is not run directly.
//
// All values are synthetic and non-secret. The 64-character broker credential is the
// literal hex alphabet repeated four times.

export const HEX = '0123456789abcdef';
export const FIXTURE_CREDENTIAL = HEX.repeat(4);          // 64 hex characters, fixture only
export const FIXTURE_PLAN_ID = `plan-${HEX.repeat(2)}`;   // plan- + 32 hex characters
export const FIXTURE_HEAD = `${HEX.repeat(2)}01234567`;   // 40 hex characters
export const FIXTURE_HEAD_AFTER = `${HEX.repeat(2)}89abcdef`;

// The broker environment keys are collected once so no file writes a
// `<name ending in TOKEN>: <value>` pair. The names are spelled out in full, unobfuscated.
export const ENV_KEYS = {
  url: 'SECRET_TUNNEL_BROKER_URL',
  credential: 'SECRET_TUNNEL_BROKER_TOKEN',
  readOnlySurface: 'GPT_REPO_READ_ONLY_SURFACE'
};

export function statusPayload(overrides = {}) {
  return {
    enabled: true,
    gitAvailable: true,
    gitVersion: 'git version 2.99.0 (fixture)',
    workspacePath: 'C:\\fixture\\workspace',
    isRepository: true,
    repository: {
      root: 'C:\\fixture\\workspace',
      head: FIXTURE_HEAD,
      branch: 'main',
      unborn: false,
      dirty: true,
      stagedPaths: [],
      unstagedPaths: ['notes.md'],
      untrackedPaths: [],
      remotes: [{ name: 'origin', url: 'https://github.com/fixture-owner/fixture-repo.git' }]
    },
    binding: {
      workspaceFingerprint: 'fixture-fingerprint',
      host: 'github.com',
      owner: 'fixture-owner',
      repo: 'fixture-repo',
      integrationBranch: 'main'
    },
    pendingPlans: [],
    blockedReason: null,
    ...overrides
  };
}

// sdk.test.mjs passes { warnings: [] } to keep the empty-warnings payload it asserted on
// before this file existed.
export function planPayload(overrides = {}) {
  return {
    id: FIXTURE_PLAN_ID,
    action: 'commit',
    repository: 'fixture-owner/fixture-repo',
    expected: {
      workspaceFingerprint: 'fixture-fingerprint',
      localHead: FIXTURE_HEAD,
      branch: 'main',
      remoteTip: null,
      contentDigest: 'fixture-content-digest',
      publication: null,
      accountLogin: null
    },
    paths: ['notes.md'],
    commitMessage: 'Fixture commit message',
    createdAtSecs: 1700000000,
    expiresAtSecs: 1700000600,
    warnings: ['fixture warning'],
    ...overrides
  };
}

export const VALID_PLAN_INPUT = { action: 'commit', paths: ['notes.md'], message: 'Fixture commit message' };

// Shared version-1 receipt, deliberately independent of the production parser.
export function receiptPayload(overrides = {}) {
  return {
    schemaVersion: 1, operationId: FIXTURE_PLAN_ID, instanceId: HEX.repeat(2),
    action: 'commit', state: 'succeeded', phase: 'complete',
    startedAtSecs: 1700000000, updatedAtSecs: 1700000001,
    commit: { beforeHead: FIXTURE_HEAD, afterHead: FIXTURE_HEAD_AFTER, committedPaths: ['notes.md'] },
    createdRepository: null, setup: [], errorCode: null, ...overrides
  };
}
