// The tunnel owns its backend; no desktop MCP process or UI is required.
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ManagedReader} from '../src/bridge/managed-reader.mjs';
import {fakeZotero} from './fake-zotero.mjs';
const pdf=process.argv[process.argv.indexOf('--pdf')+1];if(!process.argv.includes('--pdf'))throw new Error('Pass --pdf FILE');
const root=await mkdtemp(join(tmpdir(),'zotero-owned-reader-'));
const zotero=await fakeZotero({pdf});
const backend=new ManagedReader({root,serverFile:resolve('out/plugin/dist/server.mjs'),env:{...process.env,CODEX_ZOTERO_API:zotero.url,CODEX_ZOTERO_CACHE:join(root,'cache')}});
try{
 const [first,second]=await Promise.all([backend.list(),backend.list()]);assert.equal(first[0].readerSession,second[0].readerSession);
 const id=first[0].readerSession,request=(name,args={})=>backend.request(id,{method:'app',name,arguments:args});
 const hello=await request('panel_hello',{instance:'web-browser'});assert.equal(hello.result.readerSession,id);
 const opened=await request('tab_open',{itemKey:'PAPER001'}),docId=opened.result.active.document.id;
 await request('panel_report',{docId,page:1,visible:[1,1],view:'paper'});
 const old=backend.child;old.kill();await new Promise(r=>old.once('exit',r));
 const image=await request('render_page',{docId,page:1,cssWidth:700,dpr:1});assert.ok(image.result.data.length>100);
 assert.notEqual(backend.child.pid,old.pid);assert.equal((await backend.list())[0].readerSession,id);
 const poll=await request('panel_poll',{instance:'web-browser',seen:0});assert.equal(poll.result.superseded,false);assert.equal(poll.result.readerSession,id);
 await request('annotation_create',{docId,kind:'text',page:1,rects:[[20,20,100,15]],text:'Managed web note',color:'#ffd400'});
 const deadline=Date.now()+5000;while(!zotero.annotations().length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert.ok(zotero.annotations().length);
 await access(join(root,'web-reader','writes.json'));await assert.rejects(()=>access(join(root,'writes.json')));
 await assert.rejects(()=>backend.request('0'.repeat(32),{method:'status'}),/连接已更新/);
 console.log(JSON.stringify({pass:true,checks:['no desktop required','single startup under concurrency','stable web session','backend restarts on demand','document reloaded after restart','UI instance preserved','foreign session rejected','isolated durable web write queue']}));
}finally{await backend.close();await zotero.close();await rm(root,{recursive:true,force:true});}
