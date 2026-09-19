import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {relativePath, requestId, checkConfig, cleanEnvironment, makeRunner, createOperations, globMatch, digest, TEXT_LIMIT, StorageError} from './worker.mjs';
const code = expected => e => e.code === expected;
function backend(initial={}, hook=async()=>{}) {
  const files=new Map(Object.entries(initial).map(([p,b])=>[p,Buffer.from(b)])), calls=[];
  const isDir=p=>p===''||[...files.keys()].some(k=>k.startsWith(p+'/'));
  const run=async(args,options={})=>{
    calls.push(args);await hook(args,files);
    const [op,from,to]=args,p=(from||'').replace(/^stbox:/,'');
    const get=p=>{if(!files.has(p))throw new StorageError('not_found','Missing');return files.get(p);};
    if(op==='version')return Buffer.from('rclone fixture\n');
    if(op==='lsjson') {
      if(args.includes('--stat')) {
        if(isDir(p))return Buffer.from(JSON.stringify({IsDir:true,Size:-1,ModTime:'0'}));
        const b=get(p);return Buffer.from(JSON.stringify({Name:path.posix.basename(p),IsDir:false,Size:b.length,ModTime:digest(b)}));
      }
      const prefix=p?p+'/':'', entries=new Map();
      for(const [name,b]of files)if(name.startsWith(prefix)){
        const remaining=name.slice(prefix.length),first=remaining.split('/')[0],dir=remaining.includes('/');
        entries.set(first,{Name:first,IsDir:dir,Size:dir?-1:b.length,ModTime:dir?'0':digest(b)});
      }
      return Buffer.from(JSON.stringify([...entries.values()]));
    }
    if(op==='cat') {
      let b=get(p);if(args.includes('--offset'))b=b.subarray(Number(args[args.indexOf('--offset')+1]));
      if(args.includes('--count'))b=b.subarray(0,Number(args[args.indexOf('--count')+1]));
      return options.hash?{sha256:digest(b),bytes:b.length}:b;
    }
    if(op==='rcat'){files.set(p,Buffer.from(options.input));return Buffer.alloc(0);}
    if(op==='moveto'){
      const dest=to.replace(/^stbox:/,'');
      if(args.includes('--immutable')&&files.has(dest))throw new StorageError('destination_exists','Refused');
      if(files.has(dest)&&args.includes('--backup-dir'))files.set(args[args.indexOf('--backup-dir')+1].replace(/^stbox:/,'')+'/'+path.posix.basename(dest),get(dest));
      files.set(dest,get(p));files.delete(p);return Buffer.alloc(0);
    }
    if(op==='copyto'){
      if(from.startsWith('stbox:'))await fs.writeFile(to,get(p),{flag:'wx'});
      else files.set(to.replace(/^stbox:/,''),await fs.readFile(from));
      return Buffer.alloc(0);
    }
    throw Error('Unexpected fixture command '+op);
  };
  return {run,files,calls};
}
for(const p of ['../x','/x','x/../y','C:/x','x\\y','a:b','x//y','--config','a/--delete','a\0b','x/.','x/..','.ssh/id','.git/config','.env','a/token.key','x.pem','a/.secret-tunnel-history/x','trailing.','trailing '])
  test(`rejects unsafe path ${JSON.stringify(p)}`,()=>assert.throws(()=>relativePath(p)));
for(const p of ['notes.md','a space/ü.txt','研究/日本語.csv','report.csv'])test(`accepts relative path ${p}`,()=>assert.equal(relativePath(p),p));
test('root and job IDs are separately validated',()=>{assert.equal(relativePath('',true),'');assert.throws(()=>relativePath(''));assert.equal(requestId('copy-12345678'),'copy-12345678');assert.throws(()=>requestId('../secret'));});
test('configuration is provider-specific and host verification is mandatory',()=>{
  const c={host:'u123.your-storagebox.de',user:'u123-sub2',port:23,rclonePath:'/bin/rclone',knownHostsPath:'/keys/known_hosts',keyPath:'/keys/key'};
  assert.doesNotThrow(()=>checkConfig(c));
  for(const change of [{host:'localhost'},{user:'u124'},{port:443},{knownHostsPath:''},{rclonePath:'/tmp/x.cmd'},{password:'secret'}])assert.throws(()=>checkConfig({...c,...change}));
});
test('child environment does not inherit app secrets, proxies or rclone configs',()=>{
  assert.deepEqual(cleanEnvironment({PATH:'/bin',RCLONE_CONFIG:'secret',HTTPS_PROXY:'bad',SSH_AUTH_SOCK:'agent',SECRET_TUNNEL_BROKER_TOKEN:'secret',NODE_OPTIONS:'bad'}),{PATH:'/bin'});
});
test('glob handling enforces custom rules and fails closed for unsupported syntax',()=>{
  assert(globMatch('**','a/b'));assert(globMatch('**/*.pem','x.pem'));assert(globMatch('**/*.pem','a/x.pem'));
  assert(!globMatch('*.txt','a/x.txt'));assert(!globMatch('literal.txt','literalXtxt'));assert.throws(()=>globMatch('[a-z]*','x'));
});
test('list has bounded pages, hidden-path omission, and change detection',async()=>{
  const b=backend({'z.txt':'z','a.txt':'a','.env':'secret'}),ops=createOperations(b.run);
  const first=await ops.list({limit:1});assert.equal(first.entries[0].name,'a.txt');assert.equal(first.nextOffset,1);assert.equal(first.omitted,1);
  assert.equal((await ops.list({offset:1,snapshot:first.snapshot})).entries[0].name,'z.txt');
  b.files.set('b.txt',Buffer.from('b'));await assert.rejects(ops.list({offset:1,snapshot:first.snapshot}),code('listing_changed'));
});
test('nested directories remain directly accessible',async()=>{
  const ops=createOperations(backend({'a/b.txt':'hello'}).run);assert.equal((await ops.list({path:'a'})).entries[0].path,'a/b.txt');assert.equal((await ops.read({path:'a/b.txt'})).text,'hello');
});
test('complete read has whole-file hash; partial read never does',async()=>{
  const ops=createOperations(backend({'x':'hello world'}).run);
  assert.equal((await ops.read({path:'x'})).sha256,digest('hello world'));
  const v=await ops.read({path:'x',maxBytes:5});assert.equal(v.text,'hello');assert.equal(v.sha256,null);assert.equal(v.nextOffset,5);assert.equal(v.contentComplete,false);
});
test('bounded reads work beyond the whole-file edit-size limit',async()=>{
  const r=await createOperations(backend({'big':'x'.repeat(TEXT_LIMIT+100)}).run).read({path:'big',offset:TEXT_LIMIT,maxBytes:20});assert.equal(r.bytesRead,20);assert.equal(r.contentComplete,false);
});
test('UTF-8 truncated codepoint uses the exact next offset',async()=>{
  const ops=createOperations(backend({'x':'abc€xyz'}).run);const r=await ops.read({path:'x',maxBytes:5});assert.equal(r.text,'abc');assert.equal(r.nextOffset,3);assert.equal((await ops.read({path:'x',offset:3})).text,'€xyz');
  await assert.rejects(ops.read({path:'x',offset:4}),code('not_text'));
});
test('binary NUL and invalid UTF-8 at actual EOF are rejected',async()=>{
  const ops=createOperations(backend({'bad':Buffer.from([65,255]),'nul':Buffer.from([65,0])}).run);
  await assert.rejects(ops.read({path:'bad'}),code('not_text'));await assert.rejects(ops.read({path:'nul'}),code('not_text'));
});
test('create stages and hash-verifies the final destination',async()=>{
  const b=backend(),r=await createOperations(b.run).write({path:'new',content:'hello',expectedSha256:null,requestId:'write-12345678'});
  assert.equal(b.files.get('new').toString(),'hello');assert.equal(r.verified,'sha256_readback');assert.equal(r.sha256,digest('hello'));
  assert(!b.calls.some(a=>['delete','deletefile','purge','sync'].includes(a[0])));
});
test('existing destination is not replaced by a create request',async()=>{
  const b=backend({'x':'old'});await assert.rejects(createOperations(b.run).write({path:'x',content:'new',expectedSha256:null,requestId:'write-12345678'}),code('destination_exists'));assert.equal(b.files.get('x').toString(),'old');
});
test('replacement checks the full hash and retains the previous version',async()=>{
  const b=backend({'x':'old'}),r=await createOperations(b.run).write({path:'x',content:'new',expectedSha256:digest('old'),requestId:'write-12345678'});
  assert.equal(b.files.get('x').toString(),'new');assert.equal(b.files.get('.secret-tunnel-history/write-12345678/x').toString(),'old');assert.equal(r.concurrency,'optimistic_precheck_not_atomic_cas');
});
test('missing precondition or stale hash cannot replace a file',async()=>{
  const ops=createOperations(backend({'x':'old'}).run);
  await assert.rejects(ops.write({path:'x',content:'new',requestId:'write-12345678'}),code('precondition_required'));
  await assert.rejects(ops.write({path:'x',content:'new',expectedSha256:digest('other'),requestId:'write-12345678'}),code('write_conflict'));
});
test('change during staging preserves the external edit',async()=>{
  const b=backend({'x':'old'},async(a,f)=>{if(a[0]==='rcat')f.set('x',Buffer.from('external'));});
  await assert.rejects(createOperations(b.run).write({path:'x',content:'new',expectedSha256:digest('old'),requestId:'write-12345678'}),code('write_conflict'));assert.equal(b.files.get('x').toString(),'external');assert(b.files.has('.secret-tunnel-part-write-12345678'));
});
test('revocation before commit keeps the original',async()=>{
  const b=backend({'x':'old'}),ops=createOperations(b.run,{assertActive:async()=>{throw new StorageError('access_revoked','Revoked');}});
  await assert.rejects(ops.write({path:'x',content:'new',expectedSha256:digest('old'),requestId:'write-12345678'}),code('access_revoked'));assert.equal(b.files.get('x').toString(),'old');
});
test('oversized writes fail before contacting storage',async()=>{
  const b=backend();await assert.rejects(createOperations(b.run).write({path:'x',content:'x'.repeat(TEXT_LIMIT+1),expectedSha256:null,requestId:'write-12345678'}),code('write_too_large'));assert.equal(b.calls.length,0);
});
test('source-retaining binary copies in both directions',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'st-copy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from([0,1,255,254,128,3]);await fs.writeFile(path.join(dir,'source.bin'),bytes);
  const b=backend(),ops=createOperations(b.run,{roots:[{repo_id:'workspace',root:dir,writes:{enabled:true,allowed_globs:['**']}}]});
  await ops.copy({direction:'upload',repoId:'workspace',localPath:'source.bin',remotePath:'remote.bin',requestId:'upload-12345678'});assert.deepEqual(b.files.get('remote.bin'),bytes);
  await ops.copy({direction:'download',repoId:'workspace',localPath:'received.bin',remotePath:'remote.bin',requestId:'download-12345678'});assert.deepEqual(await fs.readFile(path.join(dir,'received.bin')),bytes);assert.deepEqual(await fs.readFile(path.join(dir,'source.bin')),bytes);
  await assert.rejects(ops.copy({direction:'download',repoId:'workspace',localPath:'received.bin',remotePath:'remote.bin',requestId:'download-87654321'}),code('destination_exists'));
});
test('local symlinks and non-authorised roots are refused',{skip:process.platform==='win32'},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'st-path-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'real'),'a');await fs.symlink('real',path.join(dir,'link'));
  const ops=createOperations(backend({'x':'a'}).run,{roots:[{repo_id:'workspace',root:dir,writes:{enabled:false}}]});
  const args={direction:'upload',repoId:'workspace',localPath:'link',remotePath:'new',requestId:'copy-12345678'};
  await assert.rejects(ops.copy(args),code('unsafe_local_path'));await assert.rejects(ops.copy({...args,repoId:'unknown'}),code('local_root_denied'));await assert.rejects(ops.copy({...args,direction:'download',localPath:'new'}),code('local_root_denied'));
});
test('connection test makes no write claim and performs no mutation',async()=>{
  const b=backend(),v=await createOperations(b.run).test();assert.equal(v.writeTested,false);assert(b.calls.every(a=>['version','lsjson'].includes(a[0])));
});
test('actual child spawn isolates credentials and avoids a shell',{skip:process.platform==='win32'},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'st-runner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const exe=path.join(dir,'rclone'),known=path.join(dir,'known_hosts'),key=path.join(dir,'key');
  await fs.writeFile(known,'fixture');await fs.writeFile(key,'fixture');
  await fs.writeFile(exe,`#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),known:process.env.RCLONE_CONFIG_STBOX_KNOWN_HOSTS_FILE,connections:process.env.RCLONE_CONFIG_STBOX_CONNECTIONS,secret:process.env.SECRET_TUNNEL_BROKER_TOKEN,proxy:process.env.HTTPS_PROXY}));`,{mode:0o700});
  const runner=makeRunner({host:'u123.your-storagebox.de',user:'u123',port:23,rclonePath:exe,knownHostsPath:known,keyPath:key});
  await runner.initialise();const result=JSON.parse((await runner.run(['lsjson','stbox:path with spaces'])).toString());
  assert.equal(result.known,known);assert.equal(result.connections,'3');assert.equal(result.secret,undefined);assert.equal(result.proxy,undefined);assert.equal(result.args[1],'stbox:path with spaces');runner.stop();
});
