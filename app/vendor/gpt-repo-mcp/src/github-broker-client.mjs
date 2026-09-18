import { request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { projectOperationReceipt } from './github-contract.mjs';
export { receiptZodSchema, projectOperationReceipt } from './github-contract.mjs';
const processInstanceId = randomUUID().replaceAll('-', '');
const READ_ROUTES = new Set(['/github/status', '/runtime/status', '/github/operation_status', '/github/pages_context']);

const URL_ENV = 'SECRET_TUNNEL_BROKER_URL';
const TOKEN_ENV = 'SECRET_TUNNEL_BROKER_TOKEN';
const ROUTES = new Set(['/github/status', '/github/plan', '/github/apply',
  '/github/create_repository', '/github/create_repository/apply', '/runtime/status', '/github/operation_status',
  '/github/pages_context', '/github/repo_ensure', '/github/repo_ship', '/github/pages_ensure']);
const SHA = /^[a-f0-9]{40}$/;
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const PLAN_ID = /^plan-[a-f0-9]{32}$/;
const REFUSAL_CODES = new Set(['plan_unknown', 'plan_expired', 'plan_not_approved', 'plan_approval_mismatch',
  'workspace_changed', 'settings_changed', 'local_head_moved', 'branch_changed', 'remote_moved', 'content_changed',
  'github_disabled', 'not_bound', 'not_implemented', 'unreviewed_staged_paths', 'git_failed', 'invalid_path',
  'unknown_action', 'missing_plan_id', 'no_paths', 'no_message', 'plan_store_unavailable', 'read_only_mode']);
const PRECONDITION_CODES = new Set(['plan_unknown', 'plan_expired', 'plan_not_approved', 'plan_approval_mismatch',
  'workspace_changed', 'settings_changed', 'local_head_moved', 'branch_changed', 'remote_moved', 'content_changed',
  'github_disabled', 'read_only_mode', 'not_bound', 'not_implemented', 'unknown_action', 'missing_plan_id']);
for (const code of ['github_busy', 'repository_busy', 'operation_already_claimed', 'operation_unknown',
  'publication_changed', 'publication_branch_mismatch', 'publication_repository_mismatch', 'account_changed',
  'unsupported_push_transport', 'ambiguous_push_target', 'push_configuration_unsupported', 'invalid_input',
  'invalid_paths', 'sensitive_path', 'private_store_exposed', 'detached_head', 'github_not_connected']) {
  REFUSAL_CODES.add(code); PRECONDITION_CODES.add(code);
}
for (const code of ['receipt_persistence_failed', 'operation_store_corrupt', 'operation_store_unsafe',
  'push_unverified', 'git_output_limit', 'account_store_unreadable', 'operation_history_full']) REFUSAL_CODES.add(code);
/// A code the desktop invented that still looks like a code, not a leaked
/// path or panic message. Passing these through keeps new refusal reasons
/// actionable; anything else stays hidden behind `broker_refused`.
const SAFE_CODE = /^[a-z][a-z0-9_]{2,39}$/;

/// Routes that carry something out. If one of these is interrupted the
/// outcome is unknown rather than known-not-done, because the side effect
/// may already have happened on the far side.
function applies(route) {
  return route === '/github/apply' || route === '/github/create_repository/apply';
}

export class BrokerClientError extends Error {
  constructor(code, message, outcome = 'not_sent') {
    super(message); this.name = 'BrokerClientError'; this.code = code; this.outcome = outcome;
  }
}
function requireThat(condition, code, message) {
  if (!condition) throw new BrokerClientError(code, message);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value, allowed) {
  requireThat(object(value) && Object.keys(value).every(k => allowed.includes(k)), 'invalid_input', 'Unknown or invalid request fields.');
}
function text(value, maximum = 4096) {
  requireThat(typeof value === 'string' && value.length <= maximum, 'broker_schema', 'Broker returned an invalid string field.');
  return value;
}
function nullableText(value, maximum) { return value === null ? null : text(value, maximum); }
function bool(value) { requireThat(typeof value === 'boolean', 'broker_schema', 'Broker returned an invalid boolean field.'); return value; }
function list(value, mapper, maximum = 500) {
  requireThat(Array.isArray(value) && value.length <= maximum, 'broker_schema', 'Broker returned an invalid or oversized list.');
  return value.map(mapper);
}
function head(value, nullable = true) {
  requireThat((nullable && value === null) || (typeof value === 'string' && SHA.test(value)), 'broker_schema', 'Broker returned an invalid commit identity.');
  return value;
}
function path(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\\:*?\[\]\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !value.startsWith('-')
    && value.split('/').every(p => p && p !== '.' && p !== '..'), 'invalid_path', 'Expected an exact repository-relative file path.');
  requireThat(!value.toLowerCase().split('/').some(p => p === '.git' || p === '.env' || p.startsWith('.env.')
    || /\.(pem|key|p12|pfx)$/.test(p) || ['id_rsa', 'id_ed25519', 'credentials', 'secrets'].includes(p)),
  'sensitive_path', 'Sensitive paths cannot be included in a commit plan.');
  return value;
}
export function validateBrokerInput(route, value) {
  requireThat(ROUTES.has(route), 'route_blocked', 'Only the status, plan, apply and create-repository broker routes are allowed.');
  if (route === '/github/status' || route === '/runtime/status') { exactKeys(value, []); return {}; }
  // The desktop owns the binding, so this request carries nothing at all.
  if (route === '/github/pages_context') { exactKeys(value, []); return {}; }
  if (route === '/github/pages_ensure') {
    exactKeys(value, ['domain', 'httpsEnforced']);
    const result = {};
    if (value.domain !== undefined) {
      requireThat(typeof value.domain === 'string' && value.domain.length <= 253 && DOMAIN.test(value.domain),
        'invalid_domain', 'A custom domain must be a plain lowercase hostname such as example.com.');
      result.domain = value.domain;
    }
    if (value.httpsEnforced !== undefined) {
      requireThat(typeof value.httpsEnforced === 'boolean', 'invalid_input', 'httpsEnforced must be true or false.');
      requireThat(!value.httpsEnforced || result.domain !== undefined, 'invalid_input', 'HTTPS can only be enforced for a custom domain.');
      result.httpsEnforced = value.httpsEnforced;
    }
    return result;
  }
  if (route === '/github/repo_ship') {
    // Same bounds as a commit plan: exact paths, no refspec, no destination.
    exactKeys(value, ['paths', 'message']);
    requireThat(Array.isArray(value.paths) && value.paths.length > 0 && value.paths.length <= 50, 'invalid_paths', 'Select one to fifty exact file paths.');
    const paths = value.paths.map(path);
    requireThat(new Set(paths).size === paths.length, 'invalid_paths', 'Duplicate paths are not allowed.');
    requireThat(typeof value.message === 'string' && value.message.trim().length > 0 && value.message.length <= 4000
      && !/[\x00\r]/.test(value.message), 'invalid_message', 'A bounded nonempty commit message is required.');
    return { paths, message: value.message };
  }
  if (route === '/github/repo_ensure') {
    exactKeys(value, ['name', 'visibility']);
    const result = {};
    if (value.name !== undefined) {
      requireThat(typeof value.name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value.name)
        && value.name !== '.' && value.name !== '..' && !value.name.startsWith('-'),
      'invalid_repository_name', 'A repository name may use letters, digits, dot, dash and underscore only.');
      result.name = value.name;
    }
    // Absent means private, which is what this route did before the field
    // existed; only the exact word "public" opens a new repository.
    if (value.visibility !== undefined) {
      requireThat(value.visibility === 'public' || value.visibility === 'private',
        'invalid_input', 'visibility must be "private" or "public".');
      result.visibility = value.visibility;
    }
    return result;
  }
  if (route === '/github/operation_status') {
    exactKeys(value, ['planId']);
    requireThat(typeof value.planId === 'string' && PLAN_ID.test(value.planId), 'invalid_plan_id', 'Use the issued plan identifier.');
    return { planId: value.planId };
  }
  if (route === '/github/create_repository') {
    exactKeys(value, ['name']);
    requireThat(typeof value.name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value.name)
      && value.name !== '.' && value.name !== '..' && !value.name.startsWith('-'),
    'invalid_repository_name', 'A repository name may use letters, digits, dot, dash and underscore only.');
    return { name: value.name };
  }
  if (route === '/github/create_repository/apply') {
    exactKeys(value, ['planId']);
    requireThat(typeof value.planId === 'string' && PLAN_ID.test(value.planId), 'invalid_plan_id', 'Use the exact plan ID returned by the desktop.');
    return { planId: value.planId };
  }
  if (route === '/github/apply') {
    exactKeys(value, ['planId']);
    requireThat(typeof value.planId === 'string' && PLAN_ID.test(value.planId), 'invalid_plan_id', 'Use the exact plan ID returned by the desktop.');
    return { planId: value.planId };
  }
  // Establish it is a plain object before reading any field: a hostile shape
  // must be refused, not allowed to throw out of a property access.
  requireThat(object(value), 'invalid_input', 'Unknown or invalid request fields.');
  requireThat(['commit', 'commit_push', 'push'].includes(value.action), 'unsupported_action', 'action must be commit, commit_push or push.');
  // action=push publishes an existing commit: it takes no paths and no message,
  // and accepting either would let a caller imply a change it is not making.
  if (value.action === 'push') {
    // A schema parse normalises an absent optional array to [], so accept only
    // "no actual paths" rather than "key absent"; any real path is still refused.
    exactKeys(value, ['action', 'paths', 'message']);
    requireThat(
      value.paths === undefined || (Array.isArray(value.paths) && value.paths.length === 0),
      'invalid_input', 'A push plan publishes an existing commit and takes no paths.');
    requireThat(value.message === undefined, 'invalid_input', 'A push plan publishes an existing commit and takes no message.');
    return { action: 'push', paths: [], message: undefined };
  }
  exactKeys(value, ['action', 'paths', 'message']);
  requireThat(Array.isArray(value.paths) && value.paths.length > 0 && value.paths.length <= 50, 'invalid_paths', 'Select one to fifty exact file paths.');
  const paths = value.paths.map(path);
  requireThat(new Set(paths).size === paths.length, 'invalid_paths', 'Duplicate paths are not allowed.');
  requireThat(typeof value.message === 'string' && value.message.trim().length > 0 && value.message.length <= 4000
    && !/[\x00\r]/.test(value.message), 'invalid_message', 'A bounded nonempty commit message is required.');
  return { action: value.action, paths, message: value.message };
}
function projectPlan(value) {
  requireThat(object(value) && PLAN_ID.test(value.id) && ['commit', 'push', 'commit_push', 'create_repository'].includes(value.action), 'broker_schema', 'Broker returned an invalid plan.');
  const expected = value.expected;
  requireThat(object(expected), 'broker_schema', 'Broker plan has no expected state.');
  requireThat(Number.isSafeInteger(value.createdAtSecs) && Number.isSafeInteger(value.expiresAtSecs)
    && value.createdAtSecs >= 0 && value.expiresAtSecs > value.createdAtSecs, 'broker_schema', 'Broker plan has invalid timestamps.');
  return {
    id: value.id, action: value.action, repository: text(value.repository, 205),
    expected: {
      workspaceFingerprint: text(expected.workspaceFingerprint, 128), localHead: head(expected.localHead),
      branch: nullableText(expected.branch, 512), remoteTip: head(expected.remoteTip),
      contentDigest: expected.contentDigest === undefined ? null : nullableText(expected.contentDigest, 128),
      publication: expected.publication == null ? null : projectPublication(expected.publication),
      accountLogin: expected.accountLogin == null ? null : text(expected.accountLogin, 100)
    },
    paths: list(value.paths, v => text(v, 512), 50), commitMessage: nullableText(value.commitMessage, 4000),
    createdAtSecs: value.createdAtSecs, expiresAtSecs: value.expiresAtSecs,
    warnings: list(value.warnings, v => text(v, 500), 30)
  };
}
function projectPublication(value) {
  requireThat(object(value), 'broker_schema', 'Invalid publication target.');
  const url = text(value.url, 2048);
  requireThat(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url), 'broker_schema', 'Invalid publication URL.');
  return { remote: text(value.remote, 100), url, repository: text(value.repository, 205), branch: text(value.branch, 512) };
}
/// Whether this installation may act, and as whom. Projected rather than
/// forwarded, like everything else from the broker, so an unexpected shape is
/// a refusal instead of something a caller reads as permission. No credential
/// is carried: a login name and a mode are not a token.
function projectAuthorization(value) {
  const mode = value.approvalMode === 'autonomous' ? 'autonomous' : 'local_approval';
  const authentication = value.publicationAuthentication === 'secret_tunnel_github_token'
    ? 'secret_tunnel_github_token' : 'system_git_credential_helper';
  return {
    githubConnected: bool(value.githubConnected),
    accountLogin: nullableText(value.accountLogin, 100),
    accountScope: nullableText(value.accountScope, 200),
    approvalMode: mode,
    // Stated as the question a caller actually has: may I act without a
    // desktop click? Never inferred from anything the caller supplied.
    autonomous: mode === 'autonomous',
    publicationAuthentication: authentication
  };
}
function projectRuntime(value) {
  requireThat(object(value) && value.contractVersion === 1, 'broker_schema', 'Unsupported desktop contract.');
  requireThat(/^[a-f0-9]{32}$/.test(value.instanceId), 'broker_schema', 'Invalid desktop instance identity.');
  return { applicationVersion: text(value.applicationVersion, 40), buildId: text(value.buildId, 100),
    instanceId: value.instanceId, contractVersion: 1,
    ...(value.approvalMode === undefined ? {} : projectAuthorization(value)) };
}
function projectStatus(value) {
  requireThat(object(value), 'broker_schema', 'Broker status is not an object.');
  let repository = null; let binding = null;
  if (value.repository !== null) {
    const r = value.repository;
    requireThat(object(r), 'broker_schema', 'Invalid repository state.');
    repository = { root: text(r.root), head: head(r.head), branch: nullableText(r.branch, 512),
      unborn: bool(r.unborn), dirty: bool(r.dirty), stagedPaths: list(r.stagedPaths, v => text(v, 512)),
      unstagedPaths: list(r.unstagedPaths, v => text(v, 512)), untrackedPaths: list(r.untrackedPaths, v => text(v, 512)),
      remotes: list(r.remotes, remote => {
        requireThat(object(remote), 'broker_schema', 'Invalid remote.');
        let url = text(remote.url, 2048);
        try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; url = u.href; }
        catch { if (!/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) url = '[non-HTTPS remote omitted]'; }
        return { name: text(remote.name, 128), url };
      }, 20)
    };
  }
  if (value.binding !== null) {
    const b = value.binding;
    requireThat(object(b), 'broker_schema', 'Invalid repository binding.');
    binding = { workspaceFingerprint: text(b.workspaceFingerprint, 128), host: text(b.host, 255),
      owner: text(b.owner, 100), repo: text(b.repo, 100), integrationBranch: text(b.integrationBranch, 512) };
  }
  return { enabled: bool(value.enabled), gitAvailable: bool(value.gitAvailable), gitVersion: nullableText(value.gitVersion, 150),
    workspacePath: nullableText(value.workspacePath), isRepository: bool(value.isRepository), repository, binding,
    pendingPlans: list(value.pendingPlans, projectPlan, 100),
    ...(value.approvedPlans === undefined ? {} : { approvedPlans: list(value.approvedPlans, projectPlan, 100) }),
    ...(value.recentOperations === undefined ? {} : { recentOperations: list(value.recentOperations, projectOperationReceipt, 20) }),
    ...(value.runtime === undefined ? {} : { runtime: projectRuntime(value.runtime) }),
    ...(value.apiAccountStored === undefined ? {} : { apiAccountStored: bool(value.apiAccountStored) }),
    ...(value.approvalMode === undefined ? {} : {
      ...projectAuthorization(value),
      gitCredentialProvider: projectAuthorization(value).publicationAuthentication
    }),
    ...(value.blockedCode === undefined ? {} : { blockedCode: value.blockedCode === null ? null :
      (typeof value.blockedCode === 'string' && /^[a-z_]{1,100}$/.test(value.blockedCode) ? value.blockedCode : 'github_unavailable') }),
    blockedReason: value.blockedReason === null ? null : 'GitHub actions are unavailable. See the desktop for details.' };
}
/// A repository that now exists. Carries no credential and no token-bearing URL.
function projectCreatedRepository(value) {
  requireThat(object(value), 'broker_schema', 'Broker returned an invalid repository.');
  const cloneUrl = text(value.cloneUrl, 2048);
  const htmlUrl = text(value.htmlUrl, 2048);
  for (const url of [cloneUrl, htmlUrl]) {
    requireThat(url === '' || /^https:\/\/github\.com\//.test(url), 'broker_schema', 'Broker returned a non-GitHub repository URL.');
    requireThat(!url.includes('@'), 'broker_schema', 'Broker returned a credential-bearing URL.');
  }
  return {
    fullName: text(value.fullName, 205),
    htmlUrl,
    cloneUrl,
    private: bool(value.private),
    defaultBranch: text(value.defaultBranch, 512)
  };
}
function projectResponse(route, value) {
  if (route === '/runtime/status') return projectRuntime(value);
  if (route === '/github/status') return projectStatus(value);
  if (route === '/github/plan' || route === '/github/create_repository') return projectPlan(value);
  if (route === '/github/pages_ensure') {
    requireThat(object(value), 'broker_schema', 'Broker returned an invalid Pages setup.');
    requireThat(typeof value.workflowWritten === 'boolean', 'broker_schema', 'Broker returned an invalid workflow flag.');
    requireThat(typeof value.httpsEnforced === 'boolean', 'broker_schema', 'Broker returned an invalid HTTPS flag.');
    requireThat(value.domain === null || (typeof value.domain === 'string' && DOMAIN.test(value.domain)),
      'broker_schema', 'Broker returned an invalid custom domain.');
    return { workflowPath: text(value.workflowPath, 512), workflowWritten: value.workflowWritten,
      pages: text(value.pages, 64), branch: text(value.branch, 512), domain: value.domain,
      httpsEnforced: value.httpsEnforced, note: nullableText(value.note, 500) };
  }
  if (route === '/github/repo_ensure') {
    requireThat(object(value), 'broker_schema', 'Broker returned an invalid repository.');
    requireThat(Number.isSafeInteger(value.repositoryId) && value.repositoryId > 0, 'broker_schema', 'Broker returned an invalid repository id.');
    requireThat(typeof value.created === 'boolean', 'broker_schema', 'Broker returned an invalid created flag.');
    const htmlUrl = text(value.htmlUrl, 2048);
    requireThat(/^https:\/\/github\.com\//.test(htmlUrl) && !htmlUrl.includes('@'), 'broker_schema', 'Broker returned an invalid repository URL.');
    return { owner: text(value.owner, 100), repo: text(value.repo, 100), repositoryId: value.repositoryId,
      htmlUrl, branch: text(value.branch, 512), created: value.created };
  }
  if (route === '/github/pages_context') {
    requireThat(object(value), 'broker_schema', 'Broker returned an invalid Pages context.');
    requireThat(Number.isSafeInteger(value.repositoryId) && value.repositoryId > 0, 'broker_schema', 'Broker returned an invalid repository id.');
    requireThat(value.pagesDomain === null || (typeof value.pagesDomain === 'string' && DOMAIN.test(value.pagesDomain)),
      'broker_schema', 'Broker returned an invalid bound custom domain.');
    requireThat(value.workflowPath === null || (typeof value.workflowPath === 'string'
      && /^[A-Za-z0-9._\/-]{1,200}\.ya?ml$/.test(value.workflowPath)), 'broker_schema', 'Broker returned an invalid workflow path.');
    let pagesSite = null;
    if (value.pagesSite !== null && value.pagesSite !== undefined) {
      const site = value.pagesSite;
      requireThat(object(site), 'broker_schema', 'Broker returned an invalid Pages site.');
      requireThat(site.httpsEnforced === true || site.httpsEnforced === false, 'broker_schema', 'Broker returned an invalid HTTPS flag.');
      pagesSite = {
        buildType: nullableText(site.buildType, 32),
        htmlUrl: nullableText(site.htmlUrl, 2048),
        cname: site.cname === null ? null : (DOMAIN.test(site.cname ?? '') ? site.cname : null),
        httpsEnforced: site.httpsEnforced,
        sourceBranch: nullableText(site.sourceBranch, 512),
        sourcePath: nullableText(site.sourcePath, 512)
      };
      requireThat(pagesSite.htmlUrl === null || /^https?:\/\/[a-z0-9.-]+\//.test(pagesSite.htmlUrl),
        'broker_schema', 'Broker returned an invalid Pages URL.');
    }
    return { repository: text(value.repository, 205), repositoryId: value.repositoryId,
      commit: head(value.commit, false), branch: text(value.branch, 512), pagesDomain: value.pagesDomain,
      workflowPath: value.workflowPath, pagesSite };
  }
  return projectOperationReceipt(value);
}
function scrub(value, secret) {
  if (typeof value === 'string') return value.split(secret).join('[redacted]')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@');
  if (Array.isArray(value)) return value.map(v => scrub(v, secret));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secret)]));
  return value;
}

export function createBrokerClient(env = process.env, options = {}) {
  const base = env[URL_ENV]; const credential = env[TOKEN_ENV];
  if (!base && !credential) return null;
  const matched = typeof base === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(base) : null;
  requireThat(matched && Number(matched[1]) <= 65535 && typeof credential === 'string' && /^[a-f0-9]{64}$/.test(credential),
    'broker_configuration', 'GitHub tools require a valid local broker configuration.');
  const port = Number(matched[1]);
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxResponseBytes = options.maxResponseBytes ?? 262144;
  const maxConcurrent = options.maxConcurrent ?? 4;
  requireThat(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 30000
    && Number.isInteger(maxResponseBytes) && maxResponseBytes >= 128 && maxResponseBytes <= 262144
    && Number.isInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 4,
  'broker_configuration', 'Invalid broker limits.');
  let active = 0;
  return Object.freeze({
    async call(route, input, { signal } = {}) {
      const body = JSON.stringify(validateBrokerInput(route, input));
      requireThat(Buffer.byteLength(body) <= 32768, 'request_too_large', 'Broker request exceeds its byte limit.');
      requireThat(env[URL_ENV] === base && env[TOKEN_ENV] === credential, 'broker_configuration_changed', 'Broker configuration changed. Reconnect the app.');
      requireThat(READ_ROUTES.has(route) || env.GPT_REPO_READ_ONLY_SURFACE !== '1', 'read_only', 'GitHub mutations are disabled in read-only mode.');
      requireThat(!signal?.aborted, 'broker_canceled', 'Broker request was canceled before sending.');
      requireThat(active < maxConcurrent, 'broker_busy', 'Too many local broker requests.');
      active += 1;
      try {
        return await new Promise((resolve, reject) => {
          let req; let settled = false;
          const uncertain = applies(route) ? 'unknown' : 'not_applied';
          const fail = (code, message, outcome = uncertain) => finish(new BrokerClientError(code, message, outcome));
          const finish = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal?.removeEventListener('abort', canceled);
            if (error) { req?.destroy(); reject(error); } else resolve(value);
          };
          const canceled = () => fail('broker_canceled', 'Local request canceled. The desktop operation may still have completed.');
          const timer = setTimeout(() => fail('broker_timeout', 'Broker deadline exceeded. Inspect the desktop and Git state; do not retry automatically.'), timeoutMs);
          signal?.addEventListener('abort', canceled, { once: true });
          req = httpRequest({
            hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false, maxHeaderSize: 16384,
            headers: { 'content-type': 'application/json', 'accept': 'application/json', 'accept-encoding': 'identity',
              'content-length': Buffer.byteLength(body), authorization: `Bearer ${credential}` }
          }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400) { fail('broker_redirect', 'Broker redirects are forbidden.'); res.destroy(); return; }
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
              fail('broker_encoding', 'Compressed broker responses are not supported.'); res.destroy(); return;
            }
            if (Number(res.headers['content-length']) > maxResponseBytes) { fail('broker_response_limit', 'Broker response exceeds its byte limit.'); res.destroy(); return; }
            const chunks = []; let size = 0;
            res.on('data', chunk => {
              size += chunk.length;
              if (size > maxResponseBytes) { fail('broker_response_limit', 'Broker response exceeds its byte limit.'); res.destroy(); }
              else chunks.push(chunk);
            });
            res.on('aborted', () => fail('broker_interrupted', 'Broker response was interrupted. Inspect the desktop before retrying.'));
            res.on('error', () => fail('broker_network', 'The local broker response failed.'));
            res.on('end', () => {
              if (settled) return;
              let value;
              try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
              catch { fail('broker_json', 'Broker returned invalid JSON.'); return; }
              if (res.statusCode !== 200) {
                const reported = object(value?.error) ? value.error.code : undefined;
                const code = typeof reported === 'string'
                  && (REFUSAL_CODES.has(reported) || SAFE_CODE.test(reported))
                  ? reported : 'broker_refused';
                const outcome = applies(route) && (res.statusCode >= 500 || !PRECONDITION_CODES.has(code)) ? 'unknown' : 'refused';
                fail(code, 'The desktop refused or could not complete this request. Inspect its status.', outcome);
                return;
              }
              try { finish(null, scrub(projectResponse(route, value), credential)); }
              catch { fail('broker_schema', 'Broker result does not match the supported response contract. Inspect the desktop before retrying.'); }
            });
          });
          req.on('error', () => fail('broker_network', 'The local broker request failed.'));
          req.on('upgrade', (_res, socket) => { socket.destroy(); fail('broker_upgrade', 'Protocol upgrades are forbidden.'); });
          req.end(body);
        });
      } finally { active -= 1; }
    }
  });
}

export function createGitHubHandlers(client, readOnlySurface = false) {
  async function invoke(route, args, extra = {}) {
    try {
      requireThat(client, 'broker_unavailable', 'Secret Tunnel has no valid GitHub broker.');
      requireThat(!readOnlySurface || READ_ROUTES.has(route), 'read_only', 'GitHub mutations are disabled in read-only mode.');
      const input = validateBrokerInput(route, args);
      if (!READ_ROUTES.has(route)) {
        const status = await client.call('/github/status', {}, { signal: extra.signal });
        // Creating a repository is what an unbound folder is for, so it cannot
        // require a repository to already exist and be bound.
        // Establishing the repository and binding is what these routes do, so
        // they cannot require the binding to already exist.
        const creating = route.startsWith('/github/create_repository')
          || route === '/github/repo_ensure';
        requireThat(status.enabled && (creating || status.gitAvailable), 'github_unavailable', 'Enable GitHub in the desktop first.');
        requireThat(creating || (status.isRepository && status.binding !== null && status.blockedReason === null), 'github_unavailable', 'Enable GitHub and bind the selected repository in the desktop first.');
      }
      const result = await client.call(route, input, { signal: extra.signal });
      return { ...(result.schemaVersion === 1 && ['partial', 'failed', 'unknown'].includes(result.state) ? { isError: true } : {}),
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) {
      const safe = error instanceof BrokerClientError ? { code: error.code, message: error.message, outcome: error.outcome }
        : { code: 'broker_error', message: 'The broker request could not be completed.', outcome: applies(route) ? 'unknown' : 'not_applied' };
      // A refusal is not a receipt. Sending it as structuredContent against a
      // receipt outputSchema makes the SDK reject the whole call, so the caller
      // sees a schema complaint instead of the reason. The bounded code,
      // message and outcome remain in the text content.
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: safe }) }] };
    }
  }
  return {
    status: (args = {}, extra) => invoke('/github/status', args, extra),
    operationStatus: (args, extra) => invoke('/github/operation_status', args, extra),
    plan: (args, extra) => invoke('/github/plan', args, extra),
    apply: (args, extra) => invoke('/github/apply', args, extra),
    createRepository: (args, extra) => invoke('/github/create_repository', args, extra),
    createRepositoryApply: (args, extra) => invoke('/github/create_repository/apply', args, extra),
    pagesContext: (args = {}, extra) => invoke('/github/pages_context', args, extra),
    repoEnsure: (args = {}, extra) => invoke('/github/repo_ensure', args, extra),
    repoShip: (args, extra) => invoke('/github/repo_ship', args, extra),
    pagesEnsure: (args = {}, extra) => invoke('/github/pages_ensure', args, extra)
  };
}

// A diagnostic remains callable when broker startup fails. Never expose its
// address, credential, path token, account grant or approval authority.
export async function runtimeStatus(client, readOnlySurface, configurationState = 'unconfigured') {
  const names = ['github_status', 'github_operation_status', 'github_runtime_status', 'github_pages_status'];
  // Direct tools call api.github.com from this process instead of asking the
  // desktop; they are listed here so the catalogue describes the whole GitHub
  // surface a caller can actually reach.
  names.push('github_direct_status', 'github_direct_ref');
  if (!readOnlySurface) names.push('github_plan', 'github_apply', 'github_create_repository', 'github_create_repository_apply',
    'github_pages_ensure', 'github_repo_ensure', 'repo_ship',
    'github_direct_repo_ensure', 'github_direct_publish', 'github_direct_pages_ensure', 'github_direct_pages_status');
  const safe = (value, pattern, fallback) => typeof value === 'string' && pattern.test(value) ? value : fallback;
  let identity = {
    applicationVersion: safe(process.env.SECRET_TUNNEL_APP_VERSION, /^[0-9A-Za-z.+-]{1,40}$/, 'unavailable'),
    buildId: safe(process.env.SECRET_TUNNEL_BUILD_ID, /^[a-f0-9]{12,64}$/, 'unknown'),
    instanceId: safe(process.env.SECRET_TUNNEL_INSTANCE_ID, /^[a-f0-9]{32}$/, processInstanceId),
    contractVersion: 1
  };
  let brokerState = configurationState;
  if (client) {
    try { identity = await client.call('/runtime/status', {}); brokerState = 'reachable'; }
    catch { brokerState = 'unreachable'; }
  }
  const result = { ...identity, brokerState, accessMode: readOnlySurface ? 'read' : 'read_write',
    githubTools: names.sort(), toolCatalogDigest: createHash('sha256').update(names.sort().join('\n')).digest('hex') };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}
