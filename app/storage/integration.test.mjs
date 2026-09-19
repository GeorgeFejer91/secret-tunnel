import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storageCall } from '../vendor/gpt-repo-mcp/src/storage-client.mjs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const token = 'a'.repeat(64);

// The panel is written into index.html like every other tab, so these assert the
// markup that actually ships rather than a build-time transform of it.
test('the storage tab claims one free slot and leaves the other modules alone', () => {
  const html = read('../index.html');
  for (const text of ['id="panel-storage"', 'id="tab-storage"', 'aria-controls="panel-storage"',
    'aria-labelledby="tab-storage"', 'id="storage-settings"', 'id="storage-reader"', 'id="storage-copy"'])
    assert(html.includes(text), text);
  // Slot 6 is the one it took; the tabs claimed before it must all survive.
  for (const kept of ['id="panel-overview"', 'id="panel-folders"', 'id="panel-security"',
    'id="panel-network"', 'id="panel-system-prompt"', 'id="panel-slot-7"'])
    assert(html.includes(kept), kept);
  assert(!html.includes('id="tab-slot-6"'), 'slot 6 must not remain empty as well as claimed');
});

test('the panel is wired through the shared entry point and shared text fitter', () => {
  const main = read('../src/main.ts');
  assert(main.includes('import { wireStorage } from "./storage"'), 'storage module must be imported');
  assert(main.includes('wireStorage(fitAllText)'), 'storage must use the shared fitter');
  // One module script owns the window; a second entry point would load a second
  // copy of the shared state.
  assert.equal(read('../index.html').match(/<script/gu).length, 1);
  assert(!read('../src/storage.ts').includes('measureNaturalWidth'), 'text fitting must not be duplicated');
});

test('markup IDs are unique and frontend callbacks have matching controls', () => {
  const html = read('../index.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const source = read('../src/storage.ts');
  for (const match of source.matchAll(/(?:element(?:<[^>]+>)?|input|button|select|dialog|text)\('([^']+)'[,)]/gu))
    assert(ids.includes(match[1]), match[1]);
  assert(!source.includes('innerHTML'));
});

test('desktop command, packaged worker and MCP registration are connected', () => {
  const c = JSON.parse(read('../src-tauri/tauri.conf.json'));
  assert.equal(c.bundle.resources['../storage/worker.mjs'], 'storage/worker.mjs');
  assert.equal(c.app.windows[0].width, 636); assert.equal(c.app.windows[0].height, 704);
  const lib = read('../src-tauri/src/lib.rs');
  for (const needle of ['mod storage;', 'storage_state.start_broker()', '.manage(storage_state)',
    'storage::storage_request', 'storage::StorageState>>().shutdown()'])
    assert(lib.includes(needle), needle);
  assert(read('../vendor/gpt-repo-mcp/src/register.ts').includes('registerStorageTools(server, readOnlySurface)'));
});

test('MCP transport refuses arbitrary hosts and administrative operations',async()=>{
  await assert.rejects(storageCall('status',{}, {base:'https://evil.example',token}));
  await assert.rejects(storageCall('save',{}, {base:'http://127.0.0.1:1234',token}));
});
test('MCP transport authenticates, does not follow redirects and returns real data',async()=>{
  let seen;
  const result=await storageCall('status',{}, {base:'http://127.0.0.1:1234',token,fetch:async(url,init)=>{seen={url,init};return new Response('{"enabled":false}',{status:200});}});
  assert.equal(result.enabled,false);assert.equal(seen.url,'http://127.0.0.1:1234/status');assert.equal(seen.init.headers.authorization,`Bearer ${token}`);assert.equal(seen.init.redirect,'error');
});
test('errors and malformed responses cannot be reported as success',async()=>{
  const options={base:'http://127.0.0.1:1234',token};
  await assert.rejects(storageCall('write',{}, {...options,fetch:async()=>new Response('{"error":{"code":"write_conflict","message":"Changed"}}',{status:400})}),/write_conflict/);
  await assert.rejects(storageCall('read',{}, {...options,fetch:async()=>new Response('null',{status:200})}),/invalid result/);
  await assert.rejects(storageCall('read',{}, {...options,fetch:async()=>new Response('garbage',{status:200})}),/invalid JSON/);
});
test('MCP response size is bounded',async()=>{
  await assert.rejects(storageCall('read',{}, {base:'http://127.0.0.1:1234',token,fetch:async()=>new Response(' '.repeat(2*1024*1024+1))}),/limit/);
});
