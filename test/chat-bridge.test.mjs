import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bridgeDefinitions, callBridgeTool, BRIDGE_TOOLS } from '../src/bridge/tools.mjs';
import { startLocalBridge, requestBridge, listBridgeSessions } from '../src/bridge/local.mjs';
import { REMOTE_UI_TOOLS, REMOTE_READER_URI, validateRemoteAppCall } from '../src/bridge/ui-policy.mjs';
import { createBridgeServer } from '../src/bridge/index.mjs';

const definitions=()=>Object.fromEntries(Object.entries(bridgeDefinitions()).map(([name,tool])=>[name,{...tool,run:async args=>({text:`Body for ${args.docId || name}`,data:{args}})}]));
test('model data tools exclude local files, credentials, annotation writes and implicit document routing',async()=>{
 const tools=definitions();
 for(const name of ['document_file','file_open','mineru_configure','annotate','delete_annotation','reader_open','prefs_set'])assert.ok(!BRIDGE_TOOLS.includes(name));
 for(const name of ['read_pages','paper_full_text','ocr_start','ocr_status'])await assert.rejects(()=>callBridgeTool(tools,name,{}));
 await assert.rejects(()=>callBridgeTool(tools,'paper_full_text',{docId:'../secret'}));
 await assert.rejects(()=>callBridgeTool(tools,'paper_full_text',{docId:'a'.repeat(16),path:'/tmp/paper.pdf'}));
 await assert.rejects(()=>callBridgeTool(tools,'mineru_configure',{apiKey:'secret'}));
});
test('private socket preserves session identity, rejects unknown operations and disappears on shutdown',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zotero-bridge-'));
 const a=await startLocalBridge({root,definitions:definitions(),describe:async()=>({document:{title:'A'},live:true})});
 const b=await startLocalBridge({root,definitions:definitions(),describe:async()=>({document:{title:'B'},live:true})});
 try {
  assert.equal((await stat(`/tmp/codex-zotero-${process.getuid()}/${a.id}.sock`)).mode & 0o777,0o600);
  assert.equal((await listBridgeSessions(root)).length,2);
  assert.equal((await requestBridge(a.id,{method:'status'})).document.title,'A');
  assert.equal((await requestBridge(b.id,{method:'status'})).document.title,'B');
  const full=await requestBridge(a.id,{method:'call',name:'paper_full_text',arguments:{docId:'a'.repeat(16)}});
  assert.match(full.result.text,/Body for/);
  await assert.rejects(()=>requestBridge(a.id,{method:'call',name:'delete_annotation',arguments:{}}),/未向远程/);
  await assert.rejects(()=>requestBridge('../bad',{method:'status'}));
  await a.close();assert.equal((await listBridgeSessions(root)).length,1);
  await assert.rejects(()=>requestBridge(a.id,{method:'status'}),/连接已关闭/);
 } finally {await b.close();await rm(root,{recursive:true,force:true});}
});
test('remote MCP lists individual tools, routes exact sessions and returns full content with pagination',async()=>{
 const calls=[];
 const server=createBridgeServer({root:'/unused',list:async()=>[{readerSession:'b'.repeat(32),document:{title:'Paper'}}],request:async(id,args)=>{calls.push({id,...args});return {result:{text:'Actual full text',data:{nextOffset:900,version:'v1'}}};}});
 const client=new Client({name:'test',version:'1'}), [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await Promise.all([server.connect(a),client.connect(b)]);
  const {tools}=await client.listTools();assert.equal(tools.length,BRIDGE_TOOLS.length+REMOTE_UI_TOOLS.length+2);
  const full=tools.find(t=>t.name==='paper_full_text');assert.ok(full.inputSchema.required.includes('readerSession'));assert.ok(full.inputSchema.required.includes('docId'));
  assert.equal(full.annotations.readOnlyHint,true);assert.equal(tools.find(t=>t.name==='ocr_start').annotations.readOnlyHint,false);
  const missing=await client.callTool({name:'paper_full_text',arguments:{docId:'a'.repeat(16)}});assert.equal(missing.isError,true);assert.equal(calls.length,0);
  const result=await client.callTool({name:'paper_full_text',arguments:{readerSession:'b'.repeat(32),docId:'a'.repeat(16),maxChars:900}});
  assert.equal(result.content[0].text,'Actual full text');assert.equal(result.structuredContent.nextOffset,900);assert.equal(calls[0].id,'b'.repeat(32));assert.equal(calls[0].arguments.readerSession,undefined);
  const listed=await client.callTool({name:'reader_connections',arguments:{}});assert.equal(listed.structuredContent.connections[0].readerSession,'b'.repeat(32));
 } finally {await client.close();await server.close();}
});

test('remote reader entrypoint serves self-contained UI and app-only operations cannot configure credentials', async()=>{
 const session='c'.repeat(32),calls=[];
 const server=createBridgeServer({list:async()=>[{readerSession:session,live:true}],loadPanel:async()=>'<!doctype html><title>Reader</title>',request:async(id,args)=>{calls.push({id,...args});return {result:{active:null,tabs:[],prefs:{}}};}});
 const client=new Client({name:'ui-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try {
  await Promise.all([server.connect(a),client.connect(b)]);
  const {tools}=await client.listTools(),entry=tools.find(t=>t.name==='reader_open');
  assert.equal(entry._meta.ui.resourceUri,REMOTE_READER_URI);
  for(const name of REMOTE_UI_TOOLS)assert.deepEqual(tools.find(t=>t.name===name)._meta.ui.visibility,['app']);
  for(const name of ['mineru_configure','tunnel_configure','document_file','file_open'])assert.ok(!tools.some(t=>t.name===name));
  const {contents}=await client.readResource({uri:REMOTE_READER_URI});assert.match(contents[0].mimeType,/profile=mcp-app/);assert.match(contents[0].text,/Reader/);
  const opened=await client.callTool({name:'reader_open',arguments:{}});assert.equal(opened.structuredContent.readerSession,session);assert.equal(opened.structuredContent.view,'library');
  const routed=await client.callTool({name:'home_list',arguments:{readerSession:session,query:'Gaussian'}});assert.ok(!routed.isError);assert.equal(calls.at(-1).arguments.query,'Gaussian');assert.equal(calls.at(-1).method,'app');
  const absent=await client.callTool({name:'home_list',arguments:{query:'test'}});assert.equal(absent.isError,true);
 } finally {await client.close();await server.close();}
 for(const name of ['mineru_configure','tunnel_start','document_file','file_open'])assert.throws(()=>validateRemoteAppCall(name,{}),/仅允许在本机/);
 assert.throws(()=>validateRemoteAppCall('home_list',{query:'test',apiKey:'no'}));
 assert.equal(validateRemoteAppCall('annotation_update',{docId:'a'.repeat(16),key:'ANNOT001',comment:'My comment'}).comment,'My comment');
});
test('remote reader entrypoint requires disambiguation when multiple services are live', async()=>{
 const server=createBridgeServer({list:async()=>[{readerSession:'a'.repeat(32),live:true},{readerSession:'b'.repeat(32),live:true}],request:async()=>{throw new Error('must not route');}});
 const client=new Client({name:'ui-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try {await Promise.all([server.connect(a),client.connect(b)]);const result=await client.callTool({name:'reader_open',arguments:{}});assert.equal(result.isError,true);assert.match(result.content[0].text,/reader_connections/);}finally{await client.close();await server.close();}
});
