// Actual bundled reader + separate bundled stdio bridge, with isolated Zotero/cache.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeZotero } from './fake-zotero.mjs';
const pdf=process.argv[process.argv.indexOf('--pdf')+1];
if(!process.argv.includes('--pdf'))throw new Error('Pass --pdf FILE');
const root=await mkdtemp(join(tmpdir(),'zotero-bridge-e2e-'));
const zotero=await fakeZotero({pdf,annotations:[{annotationType:'highlight',annotationText:'Highlighted evidence',annotationComment:'Complete user comment',annotationColor:'#ffd400',annotationPageLabel:'1',annotationSortIndex:'00000|000001|00000',annotationPosition:JSON.stringify({pageIndex:0,rects:[[20,20,100,40]]})}]});
const env={...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache'),CODEX_ZOTERO_API:zotero.url,MINERU_API_KEY:''};
const reader=spawn(process.execPath,['out/plugin/dist/server.mjs','--standalone','--chat-bridge','--item','PAPER001'],{env,stdio:['ignore','ignore','pipe']});
const url=await new Promise((resolve,reject)=>{let log='';reader.stderr.on('data',c=>{log+=c;const m=log.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});reader.on('exit',()=>reject(new Error(log)));});
const call=async(name,args={})=>{const r=await fetch(new URL('/api/call',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});assert.equal(r.status,200);return r.json();};
const client=new Client({name:'remote-bridge-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:['out/plugin/dist/chat-bridge.mjs'],env,stderr:'pipe'});
try {
 const hello=await call('panel_hello',{instance:'bridge-check'}),doc=hello.active.document,readerSession=hello.readerSession;
 assert.match(readerSession,/^[a-f0-9]{32}$/);
 await call('panel_report',{docId:doc.id,page:1,visible:[1,1],view:'paper'});
 await client.connect(transport);
 const connections=await client.callTool({name:'reader_connections',arguments:{}});assert.equal(connections.structuredContent.connections[0].readerSession,readerSession);
 const {tools}=await client.listTools();assert.ok(!tools.some(t=>t.name==='mineru_configure'||t.name==='document_file'));
 const state=await client.callTool({name:'reader_state',arguments:{readerSession}});assert.equal(state.structuredContent.docId,doc.id);
 // A cache produced by the UI/analysis service must be read by the same runtime without another OCR.
 const dir=join(env.CODEX_ZOTERO_CACHE,doc.id);await mkdir(dir,{recursive:true});
 const pages=Object.fromEntries(Array.from({length:doc.pageCount},(_,i)=>[i+1,{text:`OCR body page ${i+1}: actual evidence`,blocks:[]} ]));
 await writeFile(join(dir,'ocr-v1.json'),JSON.stringify({source:'ocr',pages}));
 const first=await client.callTool({name:'paper_full_text',arguments:{readerSession,docId:doc.id,maxChars:32}});
 assert.equal(first.structuredContent.status,'ready');assert.equal(first.structuredContent.nextOffset,32);assert.ok(first.content[0].text.includes('actual evidence')||first.content[0].text.includes('OCR body'));
 const all=await client.callTool({name:'paper_full_text',arguments:{readerSession,docId:doc.id,maxChars:60000}});assert.equal(all.structuredContent.nextOffset,null);
 const unchanged=await client.callTool({name:'paper_full_text',arguments:{readerSession,docId:doc.id,knownVersion:all.structuredContent.version}});assert.equal(unchanged.structuredContent.status,'unchanged');
 const notes=await client.callTool({name:'research_annotations',arguments:{readerSession,itemKey:'PAPER001'}});assert.ok(notes.content[0].text.includes('Complete user comment'));
 const denied=await client.callTool({name:'paper_full_text',arguments:{readerSession}});assert.equal(denied.isError,true);
 const stale=await client.callTool({name:'ocr_status',arguments:{readerSession:'0'.repeat(32),docId:doc.id}});assert.equal(stale.isError,true);
 const batch=await client.callTool({name:'research_ocr_start',arguments:{readerSession,itemKeys:['PAPER001']}});assert.equal(batch.structuredContent.tasks[0].state,'done');
 assert.ok(!zotero.state.requests.some(r=>/^(POST|PATCH|DELETE) /.test(r)));
 console.log(JSON.stringify({pass:true,checks:['bundled stdio discovery','session matches reader','same live state','bounded independent tools','actual full text','pagination','version reuse','complete user comments','required document id','stale session rejected','OCR cache reused','no Zotero writes']}));
}finally {await client.close();await transport.close();reader.kill();await new Promise(resolve=>reader.exitCode!==null?resolve():reader.once('exit',resolve));await zotero.close();await rm(root,{recursive:true,force:true});}
