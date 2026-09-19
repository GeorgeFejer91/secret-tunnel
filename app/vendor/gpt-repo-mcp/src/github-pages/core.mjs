import { createHash } from 'node:crypto';

export const VERSION = 1;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 32 * 1024;
const SHA = /^[a-f0-9]{40}$/;
// GitHub accepts a workflow's file name wherever it accepts its numeric id.
const WORKFLOW_FILE = /^[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const stateValue = (states, value) => typeof value === 'string' && own(states, value) ? states[value] : 'unknown';

export class VerificationError extends Error {
  constructor(code, message) { super(message); this.name = 'VerificationError'; this.code = code; }
}
export function fail(code, message) { throw new VerificationError(code, message); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function strict(value, keys, label) {
  if (!OBJECT(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_REQUEST', `${label} has invalid fields.`);
}
function short(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value > 0; }
function baseUrl(value) {
  if (!short(value, 2048)) fail('UNSAFE_URL', 'Invalid Pages URL.');
  let url;
  try { url = new URL(value); } catch { fail('UNSAFE_URL', 'Invalid Pages URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !/^[a-z0-9.-]+$/.test(url.hostname) || url.hostname.endsWith('.') || !url.hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)) fail('UNSAFE_URL', 'Pages requires an approved public HTTPS host.');
  return url;
}
export function validateRequest(input) {
  strict(input, ['repository', 'repository_id', 'commit', 'branch', 'workflow_id', 'approved_site_origin', 'live'], 'request');
  if (!short(input.repository, 140) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
      input.repository.split('/')[1] === '.' || input.repository.split('/')[1] === '..') fail('INVALID_REQUEST', 'Use an owner/repository name.');
  if (!integer(input.repository_id)) fail('INVALID_REQUEST', 'The bound numeric repository_id is required.');
  if (!SHA.test(input.commit ?? '')) fail('INVALID_REQUEST', 'An exact lowercase 40-character commit is required.');
  if (own(input, 'branch') && (!short(input.branch, 200) || /(?:\.\.|@\{|[ ~^:?*\[\\])/.test(input.branch) ||
      input.branch.startsWith('-') || input.branch.startsWith('/') || input.branch.endsWith('/') ||
      input.branch.endsWith('.') || input.branch.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock')))) fail('INVALID_REQUEST', 'Invalid branch.');
  if (own(input, 'workflow_id') && !integer(input.workflow_id) && !WORKFLOW_FILE.test(input.workflow_id ?? ''))
    fail('INVALID_REQUEST', 'Invalid workflow_id.');
  if (own(input, 'approved_site_origin')) {
    const url = baseUrl(input.approved_site_origin);
    if (url.pathname !== '/' || url.origin !== input.approved_site_origin) fail('INVALID_REQUEST', 'approved_site_origin must be an exact HTTPS origin without a trailing slash.');
  }
  if (own(input, 'live')) {
    strict(input.live, ['path', 'assertion'], 'live');
    if (own(input.live, 'path')) {
      const path = input.live.path;
      if (!short(path, 512) || /[%?#:\\]/.test(path) || path.startsWith('/') ||
          path.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_REQUEST', 'Live path must stay relative to the Pages base path.');
    }
    const a = input.live.assertion;
    strict(a, ['kind', 'value', 'field'], 'assertion');
    if (a.kind === 'contains') {
      if (own(a, 'field') || !short(a.value, 4096)) fail('INVALID_REQUEST', 'contains requires a nonempty bounded value.');
    } else if (a.kind === 'sha256') {
      if (own(a, 'field') || !/^[a-f0-9]{64}$/.test(a.value ?? '')) fail('INVALID_REQUEST', 'sha256 requires an exact body digest.');
    } else if (a.kind === 'json_commit') {
      if (own(a, 'value') || (own(a, 'field') && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(a.field))) fail('INVALID_REQUEST', 'json_commit uses the request commit, never an arbitrary value.');
    } else fail('INVALID_REQUEST', 'Unknown assertion kind.');
  }
  return structuredClone(input);
}

export function apiPath(request, kind) {
  const r = validateRequest(request);
  const prefix = `/repos/${r.repository.split('/').map(encodeURIComponent).join('/')}`;
  switch (kind) {
    case 'repository': return prefix;
    case 'commit': return `${prefix}/git/commits/${r.commit}`;
    case 'pages': return `${prefix}/pages`;
    case 'deployment': return `${prefix}/pages/deployments/${r.commit}`;
    case 'builds': return `${prefix}/pages/builds?per_page=100&page=1`;
    case 'branch':
      if (!r.branch) fail('INVALID_REQUEST', 'A branch was not selected.');
      return `${prefix}/git/ref/heads/${encodeURIComponent(r.branch)}`;
    case 'workflow':
      if (!r.workflow_id) fail('INVALID_REQUEST', 'A workflow was not selected.');
      return `${prefix}/actions/workflows/${encodeURIComponent(r.workflow_id)}/runs?head_sha=${r.commit}&per_page=100&page=1`;
    default: fail('INVALID_REQUEST', 'Unknown read operation.');
  }
}
export function siteTarget(request, pages) {
  const r = validateRequest(request);
  const base = baseUrl(pages.html_url);
  const defaultHost = `${r.repository.split('/')[0].toLowerCase()}.github.io`;
  if (base.hostname !== defaultHost && r.approved_site_origin !== base.origin) fail('SITE_APPROVAL_REQUIRED', 'A custom Pages origin requires local approval.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const suffix = r.live?.path?.split('/').map(encodeURIComponent).join('/') ?? '';
  const result = new URL(suffix, base);
  if (result.origin !== base.origin || !result.pathname.startsWith(base.pathname)) fail('UNSAFE_URL', 'Live verification escaped the Pages base.');
  return result.href;
}
function envelope(value) {
  if (!OBJECT(value) || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) fail('INVALID_RESPONSE', 'Malformed read response.');
  if (value.truncated === true) fail('RESPONSE_TOO_LARGE', 'Read evidence is incomplete.');
  return value;
}
function httpCode(status) {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCESS_OR_RATE_LIMIT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 404) return 'NOT_FOUND_OR_INACCESSIBLE';
  if (status >= 300 && status < 400) return 'REDIRECT_REFUSED';
  return 'REMOTE_UNAVAILABLE';
}
function isRequestedWorkflow(run, requested) {
  return typeof requested === 'number'
    ? run.workflow_id === requested
    : run.path === `.github/workflows/${requested}`;
}
function stamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null; }
function newest(values, timeKey) {
  if (values.some(v => !OBJECT(v) || stamp(v[timeKey]) === null)) fail('INVALID_RESPONSE', 'Cannot order incomplete deployment evidence.');
  return [...values].sort((a, b) => stamp(b[timeKey]) - stamp(a[timeKey]) || (b.run_attempt ?? 0) - (a.run_attempt ?? 0) || (b.id ?? 0) - (a.id ?? 0))[0];
}
const deploymentStates = new Map([
  ['succeed', 'succeeded'], ['deployment_in_progress', 'in_progress'], ['queued', 'queued'],
  ['deployment_queued', 'queued'], ['pending', 'queued'], ['deploying', 'in_progress'],
  ['updating_pages', 'in_progress'], ['syncing_files', 'in_progress'], ['deployment_pending', 'queued'],
  ['deployment_cancelled', 'canceled'], ['cancelled', 'canceled'], ['canceled', 'canceled'],
  ['deployment_failed', 'failed'], ['failed', 'failed'], ['failure', 'failed'], ['error', 'failed']
]);

export async function inspectPages(input, { readApi, readSite, origin = 'injected_provider', now = () => new Date() } = {}) {
  const request = validateRequest(input);
  if (typeof readApi !== 'function') fail('INVALID_REQUEST', 'A trusted read provider is required.');
  const report = {
    schema_version: VERSION, kind: 'secret-tunnel.github-pages.verification',
    observed_at: now().toISOString(), evidence_origin: origin, repository: request.repository,
    repository_id: request.repository_id, requested_commit: request.commit,
    repository_identity: 'unknown', commit_available: false,
    remote_branch: { state: 'not_requested' }, pages: { state: 'unknown' },
    deployment: { state: 'unknown', evidence: 'none' }, workflow: { state: 'not_requested' },
    live: { state: 'not_requested', assertion_passed: false, commit_marker_verified: false },
    outcome: 'unverified', verified: false, network_verified: false, warnings: [], reads: []
  };
  const read = async kind => {
    const path = apiPath(request, kind);
    let reply;
    try { reply = envelope(await readApi(path)); }
    catch (error) {
      const code = error instanceof VerificationError ? error.code : 'READ_FAILED';
      report.reads.push({ kind, status: null, code });
      report.warnings.push(`${kind}:${code}`);
      return { status: 0, body: null };
    }
    report.reads.push({ kind, status: reply.status, ...(reply.status === 200 ? {} : { code: httpCode(reply.status) }) });
    return reply;
  };
  const repo = await read('repository');
  if (repo.status !== 200) { report.warnings.push('REPOSITORY_UNAVAILABLE'); return report; }
  if (!OBJECT(repo.body) || repo.body.id !== request.repository_id ||
      typeof repo.body.full_name !== 'string' || repo.body.full_name.toLowerCase() !== request.repository.toLowerCase()) {
    report.repository_identity = 'mismatch'; report.outcome = 'failed'; report.warnings.push('REPOSITORY_IDENTITY_MISMATCH'); return report;
  }
  report.repository_identity = 'verified';
  const commit = await read('commit');
  report.commit_available = commit.status === 200 && commit.body?.sha === request.commit;
  if (!report.commit_available) report.warnings.push('REQUESTED_COMMIT_NOT_VERIFIED');
  if (request.branch) {
    const branch = await read('branch');
    const valid = branch.status === 200 && branch.body?.ref === `refs/heads/${request.branch}` &&
      branch.body?.object?.type === 'commit' && SHA.test(branch.body?.object?.sha ?? '');
    report.remote_branch = { branch: request.branch, state: valid ? (branch.body.object.sha === request.commit ? 'at_requested_commit' : 'different_tip') : 'unknown',
      ...(valid ? { tip: branch.body.object.sha } : {}) };
  }
  const pages = await read('pages');
  if (pages.status !== 200 || !OBJECT(pages.body)) {
    report.warnings.push('PAGES_DISABLED_OR_INACCESSIBLE'); return report;
  }
  const source = pages.body.source;
  const mode = pages.body.build_type === 'workflow' ? 'workflow' :
    pages.body.build_type === 'legacy' || (!pages.body.build_type && OBJECT(source)) ? 'legacy' : 'unknown';
  report.pages = { state: 'configured', mode, source: null,
    cname: typeof pages.body.cname === 'string' && pages.body.cname.length <= 253 ? pages.body.cname : null,
    https_enforced: pages.body.https_enforced === true };
  if (OBJECT(source) && short(source.branch, 200) && ['/', '/docs'].includes(source.path)) {
    report.pages.source = { branch: source.branch, path: source.path };
  }
  try { report.pages.url = siteTarget(request, pages.body); }
  catch (error) { report.warnings.push(error instanceof VerificationError ? error.code : 'UNSAFE_URL'); }

  const deployment = await read('deployment');
  let deferToWorkflow = false;
  if (deployment.status === 200 && OBJECT(deployment.body) && deployment.body.status === '' && mode === 'workflow') {
    report.deployment = { state: 'not_published', evidence: 'pages_deployment_status_not_published' };
    report.warnings.push('PAGES_DEPLOYMENT_STATUS_NOT_PUBLISHED');
    deferToWorkflow = true;
  } else if (deployment.status === 200 && OBJECT(deployment.body)) {
    report.deployment = { state: deploymentStates.get(deployment.body.status) ?? 'unknown', evidence: 'pages_deployment_by_commit' };
    if (report.deployment.state === 'unknown') report.warnings.push('UNRECOGNIZED_DEPLOYMENT_STATE');
  } else if (mode === 'legacy' && deployment.status === 404) {
    const builds = await read('builds');
    if (builds.status === 200 && Array.isArray(builds.body) && builds.body.length <= 100) {
      if (builds.body.length === 100) report.warnings.push('BUILD_HISTORY_BOUNDED_TO_100');
      const matching = builds.body.filter(b => OBJECT(b) && b.commit === request.commit);
      try {
        const selected = newest(matching, 'created_at');
        if (selected) {
          const state = stateValue({ built: 'succeeded', building: 'in_progress', queued: 'queued', errored: 'failed' }, selected.status);
          report.deployment = { state, evidence: 'pages_build_exact_commit' };
        } else report.deployment = { state: 'not_observed', evidence: 'bounded_pages_builds' };
      } catch { report.warnings.push('INVALID_BUILD_EVIDENCE'); }
    } else report.warnings.push('BUILD_EVIDENCE_UNAVAILABLE');
  } else if (deployment.status === 404) {
    report.deployment = { state: 'not_observed', evidence: 'none' };
    if (mode === 'workflow') {
      report.warnings.push('PAGES_DEPLOYMENT_STATUS_NOT_PUBLISHED');
      deferToWorkflow = true;
    }
  }
  if (request.workflow_id) {
    const workflow = await read('workflow');
    if (workflow.status === 200 && OBJECT(workflow.body) && Array.isArray(workflow.body.workflow_runs) && workflow.body.workflow_runs.length <= 100) {
      const matches = workflow.body.workflow_runs.filter(r => OBJECT(r) && isRequestedWorkflow(r, request.workflow_id) &&
        r.head_sha === request.commit && r.repository?.id === request.repository_id &&
        (!request.branch || r.head_branch === request.branch) && ['push', 'workflow_dispatch', 'dynamic', 'workflow_call'].includes(r.event));
      if (workflow.body.total_count > 100) report.warnings.push('WORKFLOW_HISTORY_BOUNDED_TO_100');
      try {
        const selected = newest(matches, 'created_at');
        let state = 'not_observed';
        if (selected) {
          if (!integer(selected.id) || !integer(selected.run_attempt ?? 1)) fail('INVALID_RESPONSE', 'Invalid run identity.');
          state = selected.status === 'completed' ? stateValue({ success: 'succeeded', failure: 'failed', timed_out: 'failed', action_required: 'failed', cancelled: 'canceled', skipped: 'skipped', neutral: 'unknown', stale: 'unknown' }, selected.conclusion) :
            (['queued', 'waiting', 'pending', 'requested'].includes(selected.status) ? 'queued' : selected.status === 'in_progress' ? 'in_progress' : 'unknown');
        }
        report.workflow = { state, workflow_id: request.workflow_id, ...(selected ? { run_id: selected.id, attempt: selected.run_attempt ?? 1 } : {}) };
      } catch { report.workflow = { state: 'unknown' }; report.warnings.push('INVALID_WORKFLOW_EVIDENCE'); }
    } else report.workflow = { state: 'unknown' };
  }
  // Only a run matched to this exact commit, branch and repository can stand in
  // for the status GitHub does not publish.
  if (deferToWorkflow && ['succeeded', 'failed', 'canceled', 'queued', 'in_progress'].includes(report.workflow.state)) {
    report.deployment = { state: report.workflow.state, evidence: 'actions_workflow_run_exact_commit' };
  }
  if (request.live) {
    report.live.state = 'not_checked';
    if (report.deployment.state === 'succeeded' && report.commit_available && report.pages.url && typeof readSite === 'function') {
      try {
        const response = envelope(await readSite(report.pages.url));
        report.live.http_status = response.status;
        if (response.status !== 200) report.live.state = 'http_unverified';
        else if (typeof response.body !== 'string' && !Buffer.isBuffer(response.body)) fail('INVALID_RESPONSE', 'Invalid site evidence.');
        else {
          const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
          if (body.length > MAX_BODY_BYTES) fail('RESPONSE_TOO_LARGE', 'Site response is too large.');
          report.live.body_sha256 = sha256(body);
          report.live.bytes = body.length;
          const a = request.live.assertion;
          report.live.assertion_kind = a.kind;
          let passed = false;
          if (a.kind === 'sha256') passed = report.live.body_sha256 === a.value;
          else {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
            if (a.kind === 'contains') passed = text.includes(a.value);
            else {
              const marker = JSON.parse(text);
              const field = a.field ?? 'commit';
              passed = OBJECT(marker) && own(marker, field) && marker[field] === request.commit;
              report.live.commit_marker_verified = passed;
            }
          }
          report.live.assertion_passed = passed;
          report.live.state = passed ? 'assertion_passed' : 'content_mismatch';
        }
      } catch (error) {
        report.live.state = 'unverified';
        report.warnings.push(error instanceof VerificationError ? error.code : 'LIVE_READ_OR_PARSE_FAILED');
      }
    }
  }
  const states = [report.deployment.state, report.workflow.state];
  if (states.some(s => s === 'failed' || s === 'canceled')) report.outcome = 'failed';
  else if (states.some(s => s === 'queued' || s === 'in_progress')) report.outcome = 'pending';
  else if (report.commit_available && report.deployment.state === 'succeeded' && report.live.assertion_passed &&
           (!request.branch || report.remote_branch.state === 'at_requested_commit') &&
           (!request.workflow_id || report.workflow.state === 'succeeded')) {
    report.outcome = 'verified'; report.verified = true;
    report.network_verified = origin === 'public_https';
  }
  report.warnings = [...new Set(report.warnings)];
  return report;
}

export function exitCode(report) {
  if (report.verified === true && report.evidence_origin === 'public_https') return 0;
  if (report.outcome === 'failed') return 1;
  return 2;
}
