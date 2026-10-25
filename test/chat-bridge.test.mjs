import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bridgeDefinitions, callBridgeTool, BRIDGE_TOOLS } from '../src/bridge/tools.mjs';
import { startLocalBridge, requestBridge, listBridgeSessions } from '../src/bridge/local.mjs';
import { createBridgeServer } from '../src/bridge/index.mjs';

const definitions=()=>Object.fromEntries(Object.entries(bridgeDefinitions()).map(([name,tool])=>[name,{...tool,run:async args=>({text:`Body for ${args.docId || name}`,data:{args}})}]));
test('remote tool surface excludes local files, credentials, writes, UI and implicit document routing',async()=>{
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
  const {tools}=await client.listTools();assert.equal(tools.length,BRIDGE_TOOLS.length+1);
  const full=tools.find(t=>t.name==='paper_full_text');assert.ok(full.inputSchema.required.includes('readerSession'));assert.ok(full.inputSchema.required.includes('docId'));
  assert.equal(full.annotations.readOnlyHint,true);assert.equal(tools.find(t=>t.name==='ocr_start').annotations.readOnlyHint,false);
  const missing=await client.callTool({name:'paper_full_text',arguments:{docId:'a'.repeat(16)}});assert.equal(missing.isError,true);assert.equal(calls.length,0);
  const result=await client.callTool({name:'paper_full_text',arguments:{readerSession:'b'.repeat(32),docId:'a'.repeat(16),maxChars:900}});
  assert.equal(result.content[0].text,'Actual full text');assert.equal(result.structuredContent.nextOffset,900);assert.equal(calls[0].id,'b'.repeat(32));assert.equal(calls[0].arguments.readerSession,undefined);
  const listed=await client.callTool({name:'reader_connections',arguments:{}});assert.equal(listed.structuredContent.connections[0].readerSession,'b'.repeat(32));
 } finally {await client.close();await server.close();}
});
