import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPages, validateRequest, apiPath, siteTarget, exitCode, VerificationError, sha256, MAX_BODY_BYTES } from './core.mjs';
import { createPublicReaders, isPublicAddress, getPublicHttps } from './http.mjs';
import { main, parseArgs, readJsonFile } from './inspect.mjs';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
function fixture() {
  const request = { repository: 'example/site', repository_id: 42, commit: SHA, branch: 'main', workflow_id: 12,
    live: { path: 'index.html', assertion: { kind: 'contains', value: 'New heading' } } };
  const responses = {
    repository: { status: 200, body: { id: 42, full_name: 'example/site' } },
    commit: { status: 200, body: { sha: SHA } },
    branch: { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } } },
    pages: { status: 200, body: { build_type: 'workflow', html_url: 'https://example.github.io/site/', source: { branch: 'main', path: '/docs' } } },
    deployment: { status: 200, body: { status: 'succeed' } },
    workflow: { status: 200, body: { total_count: 1, workflow_runs: [{ id: 100, workflow_id: 12, repository: { id: 42 }, head_sha: SHA,
      head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, created_at: '2026-09-17T00:00:00Z' }] } },
    builds: { status: 200, body: [] }
  };
  let calls = [], siteCalls = [];
  const site = { status: 200, body: '<h1>New heading</h1>' };
  const readers = { origin: 'injected_provider', now: () => new Date('2026-09-17T00:00:00Z'),
    readApi: async path => { calls.push(path); const name = Object.keys(responses).find(k => { try { return apiPath(request, k) === path; } catch { return false; } }); return responses[name]; },
    readSite: async url => { siteCalls.push(url); return site; } };
  return { request, responses, site, readers, calls, siteCalls, run: () => inspectPages(request, readers) };
}

test('exact repository, commit, deployment and content pass; injected evidence is not live network proof', async () => {
  const f = fixture(); const r = await f.run();
  assert.equal(r.outcome, 'verified'); assert.equal(r.verified, true); assert.equal(r.network_verified, false);
  assert.equal(r.live.commit_marker_verified, false); assert.equal(exitCode(r), 2);
  assert.deepEqual(f.siteCalls, ['https://example.github.io/site/index.html']); assert.equal(f.calls.length, 6);
});
test('report never repeats page body, assertion value, or arbitrary remote messages', async () => {
  const f = fixture(); f.site.body += ' private-demo-data'; f.responses.deployment.body.message = 'private-demo-data';
  const json = JSON.stringify(await f.run()); assert.ok(!json.includes('private-demo-data')); assert.ok(!json.includes('New heading'));
});
test('repository id mismatch stops before all other network reads', async () => {
  const f = fixture(); f.responses.repository.body.id = 99; const r = await f.run();
  assert.equal(r.outcome, 'failed'); assert.equal(f.calls.length, 1); assert.equal(f.siteCalls.length, 0);
});
test('owner/repo mismatch stops even when numeric id matches', async () => {
  const f = fixture(); f.responses.repository.body.full_name = 'other/site'; assert.equal((await f.run()).repository_identity, 'mismatch');
});
for (const status of [401, 403, 404, 429, 500]) test(`repository HTTP ${status} is unavailable, not disabled or success`, async () => {
  const f = fixture(); f.responses.repository = { status, body: { message: 'do not echo' } }; const r = await f.run();
  assert.equal(r.verified, false); assert.equal(r.pages.state, 'unknown'); assert.equal(f.calls.length, 1);
});
test('missing commit object prevents success and live fetch', async () => {
  const f = fixture(); f.responses.commit.status = 404; const r = await f.run();
  assert.equal(r.verified, false); assert.equal(f.siteCalls.length, 0);
});
test('different branch tip is reported, not silently accepted', async () => {
  const f = fixture(); f.responses.branch.body.object.sha = OTHER; const r = await f.run();
  assert.equal(r.remote_branch.state, 'different_tip'); assert.equal(r.verified, false);
});
test('branch inspection is optional and does not collapse into Pages publishing source', async () => {
  const f = fixture(); delete f.request.branch; const r = await f.run();
  assert.equal(r.remote_branch.state, 'not_requested'); assert.equal(r.pages.source.path, '/docs'); assert.equal(r.verified, true);
});
for (const state of ['deployment_in_progress', 'deployment_queued', 'pending', 'syncing_files']) test(`deployment ${state} is pending and never reads live site`, async () => {
  const f = fixture(); f.responses.deployment.body.status = state; const r = await f.run();
  assert.equal(r.outcome, 'pending'); assert.equal(f.siteCalls.length, 0);
});
for (const state of ['deployment_failed', 'failed', 'error', 'cancelled']) test(`deployment ${state} does not pass`, async () => {
  const f = fixture(); f.responses.deployment.body.status = state; const r = await f.run(); assert.equal(r.outcome, 'failed'); assert.equal(exitCode(r), 1);
});
test('unknown server deployment status fails closed', async () => {
  const f = fixture(); f.responses.deployment.body.status = 'some_new_success'; const r = await f.run();
  assert.equal(r.deployment.state, 'unknown'); assert.equal(r.verified, false);
});
// An Actions-built site has no readable per-commit Pages deployment record, so
// for that mode the deploying run is the deployment evidence. A legacy site
// does have one, and there a green workflow is still not a substitute for it.
test('legacy site without a Pages deployment is never sufficient', async () => {
  const f = fixture(); f.responses.pages.body.build_type = 'legacy'; f.responses.deployment.status = 404;
  f.responses.builds.body = []; const r = await f.run();
  assert.equal(r.workflow.state, 'succeeded'); assert.equal(r.deployment.state, 'not_observed'); assert.equal(r.verified, false);
});
test('workflow site falls back to the deploying run for the exact commit', async () => {
  const f = fixture(); f.responses.deployment.status = 404; const r = await f.run();
  assert.equal(r.deployment.state, 'succeeded');
  assert.equal(r.deployment.evidence, 'actions_workflow_run_exact_commit');
  assert.ok(r.warnings.includes('PAGES_DEPLOYMENT_STATUS_NOT_PUBLISHED'));
  assert.equal(r.verified, true);
});
test('unrelated installer workflow is not accepted', async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].workflow_id = 99;
  const r = await f.run(); assert.equal(r.workflow.state, 'not_observed'); assert.equal(r.verified, false);
});
test('wrong commit workflow is not accepted even when green', async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].head_sha = OTHER; assert.equal((await f.run()).verified, false);
});
test('foreign repository workflow is not accepted', async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].repository.id = 99; assert.equal((await f.run()).verified, false);
});
test('pull-request test run is not the deployment run', async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].event = 'pull_request'; assert.equal((await f.run()).verified, false);
});
test('latest rerun failure wins over an older successful run', async () => {
  const f = fixture(); const run = f.responses.workflow.body.workflow_runs[0];
  f.responses.workflow.body.workflow_runs.push({ ...run, run_attempt: 2, conclusion: 'failure' });
  const r = await f.run(); assert.equal(r.workflow.attempt, 2); assert.equal(r.outcome, 'failed');
});
test('newer pending workflow does not inherit older deployment success', async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].status = 'in_progress';
  assert.equal((await f.run()).outcome, 'pending');
});
test('malformed workflow time cannot establish newest attempt', async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].created_at = 'bad'; assert.equal((await f.run()).workflow.state, 'unknown');
});
test('Pages permission failure is not treated as disabled', async () => {
  const f = fixture(); f.responses.pages.status = 404; const r = await f.run(); assert.equal(r.pages.state, 'unknown'); assert.ok(r.warnings.includes('PAGES_DISABLED_OR_INACCESSIBLE'));
});
test('legacy build lookup uses requested commit, not newest unrelated green build', async () => {
  const f = fixture(); delete f.request.workflow_id; f.responses.pages.body.build_type = 'legacy'; f.responses.deployment.status = 404;
  f.responses.builds.body = [{ commit: OTHER, status: 'built', created_at: '2026-09-17T01:00:00Z' }, { commit: SHA, status: 'errored', created_at: '2026-09-17T00:00:00Z' }];
  assert.equal((await f.run()).outcome, 'failed');
});
test('latest legacy attempt for same commit takes precedence', async () => {
  const f = fixture(); f.responses.pages.body.build_type = 'legacy'; f.responses.deployment.status = 404;
  f.responses.builds.body = [{ commit: SHA, status: 'built', created_at: '2026-09-16T00:00:00Z' }, { commit: SHA, status: 'queued', created_at: '2026-09-17T00:00:00Z' }];
  assert.equal((await f.run()).outcome, 'pending');
});
test('bounded build search never claims a deployment was not triggered', async () => {
  const f = fixture(); f.responses.pages.body.build_type = 'legacy'; f.responses.deployment.status = 404;
  f.responses.builds.body = Array.from({length:100}, () => ({ commit: OTHER })); const r = await f.run();
  assert.equal(r.deployment.state, 'not_observed'); assert.ok(r.warnings.includes('BUILD_HISTORY_BOUNDED_TO_100'));
});
test('HTTP 200 old content remains unverified', async () => {
  const f = fixture(); f.site.body = '<h1>Old heading</h1>'; const r = await f.run();
  assert.equal(r.live.state, 'content_mismatch'); assert.equal(r.verified, false); assert.equal(exitCode(r), 2);
});
test('live HTTP redirect is never accepted as a verified page', async () => {
  const f = fixture(); f.site.status = 302; assert.equal((await f.run()).verified, false);
});
test('JSON commit marker binds the live check to the expected commit', async () => {
  const f = fixture(); f.request.live = { path: 'version.json', assertion: { kind: 'json_commit' } };
  f.site.body = JSON.stringify({ commit: SHA }); const r = await f.run();
  assert.equal(r.live.commit_marker_verified, true); assert.equal(r.verified, true);
});
test('wrong JSON commit marker cannot be verified', async () => {
  const f = fixture(); f.request.live.assertion = { kind: 'json_commit' }; f.site.body = JSON.stringify({ commit: OTHER });
  assert.equal((await f.run()).verified, false);
});
test('invalid JSON body does not escape or get echoed', async () => {
  const f = fixture(); f.request.live.assertion = { kind: 'json_commit' }; const r = await f.run();
  assert.equal(r.live.state, 'unverified'); assert.equal(r.verified, false);
});
test('exact body hash assertion works without interpreting page code', async () => {
  const f = fixture(); f.request.live.assertion = { kind: 'sha256', value: sha256(f.site.body) }; assert.equal((await f.run()).verified, true);
});
test('live verification not requested must not imply live success', async () => {
  const f = fixture(); delete f.request.live; const r = await f.run(); assert.equal(r.live.state, 'not_requested'); assert.equal(r.verified, false);
});
test('oversized and truncated site data are never sufficient', async () => {
  const f = fixture(); f.site.body = 'New heading' + 'x'.repeat(MAX_BODY_BYTES); assert.equal((await f.run()).verified, false);
  f.site.body = 'New heading'; f.site.truncated = true; assert.equal((await f.run()).verified, false);
});
test('invalid UTF-8 text cannot satisfy text assertions', async () => {
  const f = fixture(); f.site.body = Buffer.from([255, ...Buffer.from('New heading')]); assert.equal((await f.run()).verified, false);
});
test('custom domain is blocked until origin is explicitly approved', async () => {
  const f = fixture(); f.responses.pages.body.html_url = 'https://custom.example.org/';
  const r = await f.run(); assert.ok(r.warnings.includes('SITE_APPROVAL_REQUIRED')); assert.equal(f.siteCalls.length, 0);
  f.request.approved_site_origin = 'https://custom.example.org'; assert.equal((await f.run()).verified, true);
});
test('site URL joins against repo base and encodes path segments', () => {
  const f = fixture(); f.request.live.path = 'a file/index.html';
  assert.equal(siteTarget(f.request, f.responses.pages.body), 'https://example.github.io/site/a%20file/index.html');
});
for (const url of ['http://example.github.io/site/', 'https://user:pass@example.github.io/', 'https://example.github.io:8443/', 'https://localhost/', 'file:///tmp/site', 'https://example.github.io/site/?secret=x']) test(`unsafe Pages URL rejected: ${url.split('?')[0]}`, () => {
  assert.throws(() => siteTarget(fixture().request, { html_url: url }), VerificationError);
});
const badRequests = [
  r => { r.command = 'anything'; }, r => { r.repository = '../outside'; }, r => { r.repository = 'owner/..'; },
  r => { r.repository_id = -1; }, r => { delete r.repository_id; }, r => { r.commit = 'main'; },
  r => { r.branch = '../bad'; }, r => { r.branch = 'x@{bad'; }, r => { r.branch = 'x/.bad'; },
  r => { r.workflow_id = '12'; }, r => { r.live.path = '../secret'; }, r => { r.live.path = '/etc/passwd'; },
  r => { r.live.path = '%2e%2e/secret'; }, r => { r.live.path = 'http://other/'; }, r => { r.live.path = 'x?token=y'; },
  r => { r.live.assertion.kind = 'eval'; }, r => { r.live.assertion.value = ''; },
  r => { r.live.assertion = {kind:'json_commit',value:OTHER}; }, r => { r.live.assertion = {kind:'json_commit',field:'__proto__'}; },
  r => { r.approved_site_origin = 'https://custom.example.org/'; }
];
for (let i=0; i<badRequests.length; i++) test(`strict request rejects invalid case ${i+1}`, () => {
  const f = fixture(); badRequests[i](f.request); assert.throws(() => validateRequest(f.request), VerificationError);
});
test('unknown API route cannot reach transport', async () => {
  const f = fixture(); let calls=0; const reader = createPublicReaders(f.request, {transport:async()=>{calls++;}});
  assert.throws(() => reader.readApi('/user'), VerificationError); assert.equal(calls,0);
});
test('public API transport receives no authorization token and only typed paths', async () => {
  const f = fixture(); const calls=[]; const reader=createPublicReaders(f.request,{transport:async(...args)=>{calls.push(args);return {status:200,body:{}};}});
  await reader.readApi(apiPath(f.request,'deployment')); assert.equal(calls[0][0],`https://api.github.com/repos/example/site/pages/deployments/${SHA}`);
  assert.equal(calls[0][1].json,true); assert.equal(calls[0][1].headers,undefined);
});
for (const address of ['127.0.0.1','0.0.0.0','10.1.2.3','100.64.0.1','169.254.169.254','172.31.1.1','192.168.1.1','192.0.2.1','198.18.1.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::','2001::1','not-an-ip']) test(`public DNS guard rejects ${address}`, () => assert.equal(isPublicAddress(address),false));
for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) test(`public DNS guard accepts routable ${address}`, () => assert.equal(isPublicAddress(address),true));
test('HTTPS transport rejects plaintext and literal IP before network', async () => {
  await assert.rejects(getPublicHttps('http://example.org/'), {code:'UNSAFE_URL'});
  await assert.rejects(getPublicHttps('https://127.0.0.1/'), {code:'UNSAFE_URL'});
});
function mockHttps(t, {status=200,body='{}',headers={},neverEnd=false}={}) {
  const calls=[];
  t.mock.method(https,'get',(url,options,callback)=>{
    calls.push({url:String(url),options}); const req=new EventEmitter(); req.destroy=()=>{};
    queueMicrotask(()=>{ const res=new PassThrough(); res.statusCode=status; res.headers=headers; res.complete=true;
      callback(res); if(!neverEnd) res.end(body); }); return req;
  }); return calls;
}
test('HTTPS GET attaches no cookies/auth and uses vetted lookup', async t => {
  const calls=mockHttps(t); await getPublicHttps('https://api.github.com/repos/example/site',{json:true});
  assert.equal(calls[0].options.headers.Authorization,undefined); assert.equal(calls[0].options.headers.Cookie,undefined);
  assert.equal(calls[0].options.rejectUnauthorized,true); assert.equal(typeof calls[0].options.lookup,'function');
});
test('HTTPS refuses redirect body without following Location', async t => {
  const calls=mockHttps(t,{status:302,headers:{location:'http://127.0.0.1/'}}); const r=await getPublicHttps('https://example.org/');
  assert.equal(r.status,302); assert.equal(r.body,null); assert.equal(calls.length,1);
});
test('HTTPS rejects oversized response', async t => {
  mockHttps(t,{body:'x'.repeat(MAX_BODY_BYTES+1)}); await assert.rejects(getPublicHttps('https://example.org/'),{code:'RESPONSE_TOO_LARGE'});
});
test('HTTPS rejects compressed evidence instead of decompressing without a bound', async t => {
  mockHttps(t,{headers:{'content-encoding':'gzip'}}); await assert.rejects(getPublicHttps('https://example.org/'),{code:'UNSUPPORTED_ENCODING'});
});
test('HTTPS deadline returns a typed timeout', async t => {
  mockHttps(t,{neverEnd:true}); const keepAlive=setTimeout(()=>{},1000);
  try { await assert.rejects(getPublicHttps('https://example.org/',{timeoutMs:5}),{code:'TIMEOUT'}); } finally {clearTimeout(keepAlive);}
});
test('HTTPS cancellation returns a typed error', async t => {
  mockHttps(t,{neverEnd:true}); const c=new AbortController(); const p=getPublicHttps('https://example.org/',{signal:c.signal}); c.abort();
  await assert.rejects(p,{code:'CANCELED'});
});
test('API provider exceptions are sanitized', async () => {
  const f=fixture(); f.readers.readApi=async()=>{throw new Error('private-demo-data');}; const r=await f.run();
  assert.equal(r.verified,false); assert.ok(!JSON.stringify(r).includes('private-demo-data'));
});
test('CLI requires explicit live consent or a snapshot', () => {
  assert.throws(()=>parseArgs(['--request','a.json']),{code:'USAGE'});
  assert.throws(()=>parseArgs(['--request','a.json','--live','--snapshot','b.json']),{code:'USAGE'});
  assert.throws(()=>parseArgs(['--request','a.json','--live','--command','x']),{code:'USAGE'});
  assert.equal(parseArgs(['--request','a.json','--live']).live,true);
});
test('CLI help and malformed arguments have correct codes', async () => {
  const output=[]; assert.equal(await main(['--help'],{stdout:x=>output.push(x)}),0);
  assert.match(output[0],/GET-only/); assert.equal(await main(['--unknown'],{stdout:x=>output.push(x)}),3);
});
test('CLI offline snapshot runs real classifier but never reports live network verification', async () => {
  const f=fixture(); const dir=await mkdtemp(join(tmpdir(),'st-pages-test-'));
  try {
    const api={}; for(const [kind,value] of Object.entries(f.responses)) api[apiPath(f.request,kind)]=value;
    const snapshot={schema_version:1,api,site:{url:'https://example.github.io/site/index.html',response:f.site}};
    await writeFile(join(dir,'request.json'),JSON.stringify(f.request)); await writeFile(join(dir,'snapshot.json'),JSON.stringify(snapshot));
    let text=''; const code=await main(['--request',join(dir,'request.json'),'--snapshot',join(dir,'snapshot.json')],{stdout:x=>{text+=x;}});
    const report=JSON.parse(text); assert.equal(code,2); assert.equal(report.verified,true); assert.equal(report.network_verified,false); assert.equal(report.evidence_origin,'supplied_snapshot');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('bounded input file rejects excessive data', async () => {
  const dir=await mkdtemp(join(tmpdir(),'st-pages-size-'));
  try {const path=join(dir,'oversize.json');await writeFile(path,'x'.repeat(100));await assert.rejects(readJsonFile(path,10),{code:'INVALID_INPUT_FILE'});}
  finally {await rm(dir,{recursive:true,force:true});}
});
test('input file refuses symlink when platform permits creation', async t => {
  const dir=await mkdtemp(join(tmpdir(),'st-pages-link-'));
  try {await writeFile(join(dir,'real.json'),'{}');try {await symlink(join(dir,'real.json'),join(dir,'link.json'));}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Native symlink permission unavailable');return;}throw e;}
    await assert.rejects(readJsonFile(join(dir,'link.json'),100),{code:'INVALID_INPUT_FILE'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

for (const state of ['__proto__', 'constructor', 'toString']) test(`inherited object member ${state} is never a workflow state`, async () => {
  const f = fixture(); f.responses.workflow.body.workflow_runs[0].conclusion = state;
  const r = await f.run(); assert.equal(r.workflow.state, 'unknown'); assert.equal(r.verified, false);
});
for (const state of ['__proto__', 'constructor', 'toString']) test(`inherited object member ${state} is never a legacy build state`, async () => {
  const f = fixture(); f.responses.pages.body.build_type = 'legacy'; f.responses.deployment.status = 404;
  f.responses.builds.body = [{commit: SHA, status: state, created_at: '2026-09-17T00:00:00Z'}];
  const r = await f.run(); assert.equal(r.deployment.state, 'unknown'); assert.equal(r.verified, false);
});
for (const address of ['192.88.99.1', '2001:2::1', '2001:20::1', '3fff::1']) test(`special-purpose address ${address} is rejected`, () => {
  assert.equal(isPublicAddress(address), false);
});
