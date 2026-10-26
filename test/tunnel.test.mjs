import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { TunnelManager } from '../src/server/tunnel.mjs';

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'zotero-tunnel-'));let running=false,bridge=false,ready=false;const calls=[];
 const binary=join(root,'bin','tunnel-client');await mkdir(join(root,'bin'));await writeFile(binary,'test');
 const manager=new TunnelManager({root,bridgeFile:join(root,"reader's files",'chat-bridge.mjs'),binary,setBridge:async enabled=>{bridge=enabled;},getBridge:()=>bridge,run:async(file,args,options)=>{
   calls.push({file,args,options});
   if(args[1]==='connect'){running=true;return {stdout:'{}'};}
   if(args[1]==='stop'){running=false;return {stdout:'{}'};}
   return {stdout:JSON.stringify({process_running:running,healthy:running,ready,control_plane_poll_health:{state:'direct'},error:'',secret:'MUST NOT RETURN'})};
 }});
 return {root,manager,calls,ready:()=>{ready=true;},close:()=>rm(root,{recursive:true,force:true})};
}
test('tunnel configuration is private, validates ids and never returns or passes raw credentials',async()=>{
 const f=await fixture();try {
  await assert.rejects(()=>f.manager.configure({tunnelId:'../../bad',apiKey:'private-key'}),/隧道 ID/);
  const result=await f.manager.configure({tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',apiKey:'private-key'});
  assert.equal(result.keyConfigured,true);assert.equal(result.autoConnect,false);
  assert.ok(!JSON.stringify(result).includes('private-key'));
  assert.equal((await stat(f.manager.keyFile)).mode&0o777,0o600);
  await f.manager.configure({tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',apiKey:'',autoConnect:true});
  assert.equal(await readFile(f.manager.keyFile,'utf8'),'private-key');
  await f.manager.start();const command=f.calls.find(c=>c.args[1]==='connect');
  assert.ok(command.args.includes('file:'+f.manager.keyFile));assert.ok(!JSON.stringify(command).includes('private-key'));
  assert.ok(command.args[command.args.indexOf('--mcp-command')+1].includes('--state-root'));
  assert.equal(command.options.env.CONTROL_PLANE_API_KEY,undefined);
  assert.equal(command.options.env.TUNNEL_CLIENT_STATE_DIR,join(f.root,'chat-connection','runtime'));
 } finally {await f.close();}
});
test('a running process is not reported ready; stop clears auto-start and forget removes only local credentials',async()=>{
 const f=await fixture();try {
  await f.manager.configure({tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',apiKey:'private-key',autoConnect:true});
  let state=await f.manager.start();assert.equal(state.state,'starting');assert.equal(state.ready,false);assert.equal(state.chatVerified,false);
  f.ready();state=await f.manager.status(true);assert.equal(state.state,'ready');assert.ok(!JSON.stringify(state).includes('MUST NOT RETURN'));
  state=await f.manager.stop({clear:true});assert.equal(state.keyConfigured,false);assert.equal(state.tunnelId,'');assert.equal(state.bridgeEnabled,false);
  assert.ok(!f.calls.some(c=>c.args.includes('delete')));
 } finally {await f.close();}
});
test('failed actions redact raw process errors, including key material',async()=>{
 const f=await fixture();try {
  await f.manager.configure({tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',apiKey:'private-key'});
  f.manager.run=async()=>{throw Object.assign(new Error('private-key'),{stderr:'401 private-key'});};
  await assert.rejects(()=>f.manager.start(),/运行密钥无效/);
  assert.ok(!JSON.stringify(await f.manager.status()).includes('private-key'));
 } finally {await f.close();}
});
test('installer fetches only official release assets, verifies checksum, and stays off until requested',async()=>{
 const f=await fixture();try {
  await rm(f.manager.binary);let requests=[];
  const archive=zipSync({'bundle/tunnel-client':Buffer.from('verified binary'),'../../ignored':Buffer.from('not installed')});
  const name='tunnel-client-v0.0.18-darwin-arm64.zip',base='https://github.com/openai/tunnel-client/releases/download/v0.0.18/';
  const payload={tag_name:'v0.0.18',assets:[name,'SHA256SUMS.txt'].map(name=>({name,browser_download_url:base+name}))};
  f.manager.platform='darwin';f.manager.arch='arm64';
  f.manager.fetcher=async url=>{requests.push(url);return new Response(url.includes('api.github')?JSON.stringify(payload):url.endsWith('.zip')?archive:createHash('sha256').update(archive).digest('hex')+'  '+name);};
  assert.equal((await f.manager.status()).state,'missing-client');assert.equal(requests.length,0);
  await f.manager.install();await f.manager.installation;
  assert.equal(await readFile(f.manager.binary,'utf8'),'verified binary');assert.equal((await stat(f.manager.binary)).mode&0o777,0o700);
  assert.equal(requests.length,3);assert.equal(f.calls.length,0);
  await rm(f.manager.binary);f.manager.fetcher=async url=>new Response(url.includes('api.github')?JSON.stringify(payload):url.endsWith('.zip')?archive:'0'.repeat(64)+'  '+name);
  await f.manager.install();await f.manager.installation;assert.equal((await f.manager.status()).installed,false);assert.match((await f.manager.status()).error,/校验失败/);
 } finally {await f.close();}
});

test('healthy local process does not imply that the control-plane route works',async()=>{
 const f=await fixture();try {
  await f.manager.configure({tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',apiKey:'private-key'});
  f.manager.run=async()=>({stdout:JSON.stringify({process_running:true,healthy:true,ready:true,control_plane_poll_health:{state:'failed'}})});
  const result=await f.manager.status(true);assert.equal(result.ready,false);assert.equal(result.state,'error');
 } finally {await f.close();}
});

test('first configuration accepts the real client not-known alias response',async()=>{
 const f=await fixture();try {
  f.manager.run=async()=>{throw Object.assign(new Error('exit 1'),{stderr:'alias zotero-test is not known; run create or connect first'});};
  const state=await f.manager.configure({tunnelId:'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',apiKey:'private-key'});
  assert.equal(state.keyConfigured,true);assert.equal(state.state,'stopped');assert.equal(state.error,'');
  assert.equal((await f.manager.stop({clear:true})).keyConfigured,false);
 } finally {await f.close();}
});
