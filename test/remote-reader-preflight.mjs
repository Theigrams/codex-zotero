// Built remote App -> official AppBridge -> stdio MCP -> private socket -> real reader service.
// This emulates a web host without the desktop-only extensions. No real account or library is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeZotero } from './fake-zotero.mjs';
const pdf=process.argv[process.argv.indexOf('--pdf')+1];
if(!process.argv.includes('--pdf'))throw new Error('Pass --pdf FILE');
const root=await mkdtemp(join(tmpdir(),'zotero-web-reader-'));
const zotero=await fakeZotero({pdf,title:'Remote reader test paper'});
const env={...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache'),CODEX_ZOTERO_API:zotero.url,CODEX_ZOTERO_FAST:'1',MINERU_API_KEY:''};
const managed=process.env.TEST_MANAGED_READER==='1';
const native=managed?null:spawn(process.execPath,['out/plugin/dist/server.mjs','--standalone','--chat-bridge'],{env,stdio:['ignore','ignore','pipe']});
const nativeUrl=managed?null:await new Promise((resolve,reject)=>{let log='';native.stderr.on('data',c=>{log+=c;const m=log.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});native.on('exit',()=>reject(new Error(log)));});
const client=new Client({name:'web-reader-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:['out/plugin/dist/chat-bridge.mjs',...(managed?['--managed-reader']:[])],env,stderr:'pipe'});
let browser,http;
const calls=[];let injected=false,manualBlocked=process.env.TEST_REMOTE_FAIL_MANUAL==='1';
try {
 await client.connect(transport);
 const {tools}=await client.listTools();const entry=tools.find(t=>t.name==='reader_open');
 const opened=await client.callTool({name:'reader_open',arguments:{}});
 assert.ok(!opened.isError,JSON.stringify(opened));assert.equal(opened.structuredContent.view,'library');
 const session=opened.structuredContent.readerSession;
 const resource=await client.readResource({uri:entry._meta.ui.resourceUri});
 const html=resource.contents[0].text;
 assert.ok(html.includes('window.__ZOTERO_REMOTE__=true'));
 assert.ok(!/url\(fonts\//.test(html),'web font requests must be embedded');
 const host=await readFile('out/plugin/dist/host.html','utf8');
 http=createServer(async(req,res)=>{
  try {
   if(req.url==='/test/recover'){manualBlocked=false;return res.end('ok');}
   if(req.url.startsWith('/host')){res.setHeader('Content-Type','text/html');return res.end(host);}
   if(req.url==='/panel'){res.setHeader('Content-Type','text/html');return res.end(html);}
   if(req.url==='/api/tool'){
    let body='';for await(const c of req)body+=c;const args=JSON.parse(body);calls.push(args);
    if(args.name==='render_page' && (manualBlocked || process.env.TEST_REMOTE_FAIL_ONCE==='1'&&!injected)){
      injected=true;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({isError:true,content:[{type:'text',text:'MCP server is not initialized; send initialize and notifications/initialized before operational requests'}]}));
    }
    res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(await client.callTool(args)));
   }
   res.writeHead(404);res.end();
  }catch(e){res.writeHead(500);res.end(e.message);}
 });
 await new Promise(r=>http.listen(0,'127.0.0.1',r));
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,defaultViewport:{width:1280,height:900,deviceScaleFactor:2}});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${http.address().port}/host?web`);
 await page.waitForFunction(()=>window.__appCapabilities()?.availableDisplayModes?.includes('fullscreen'));
 await page.evaluate(data=>window.__activate(data),opened.structuredContent);
 const frame=page.frames().find(f=>f.url().endsWith('/panel'));
 await frame.waitForFunction(()=>window.__reader && !document.getElementById('home').hidden);
 await frame.click('#readerMore');await frame.click('#readerDisplay');
 await page.waitForFunction(()=>window.__displayRequests.includes('inline'));
 await frame.click('#readerMore');await frame.click('#readerDisplay');
 await page.waitForFunction(()=>window.__displayRequests.includes('fullscreen'));
 await frame.type('#search','Remote');await frame.waitForSelector('#homeList li');await frame.click('#homeList li');
 if(process.env.TEST_REMOTE_FAIL_MANUAL==='1'){
  await frame.waitForSelector('.page-status button',{visible:true});
  await page.evaluate(()=>fetch('/test/recover'));await frame.click('.page-status button');
 }
 await frame.waitForFunction(()=>window.__reader?.doc?.itemKey==='PAPER001' && window.__reader.imageStats.loaded>0);
 const doc=await frame.evaluate(()=>({id:window.__reader.doc.id,pageCount:window.__reader.doc.pageCount}));
 assert.equal(await frame.$eval('#localOcrSettings',e=>getComputedStyle(e).display),'none');
 assert.equal(await frame.$eval('#localConnectionSettings',e=>getComputedStyle(e).display),'none');
 await frame.evaluate(()=>window.__selection.set({kind:'text',page:1,text:'Selected evidence',rects:[[30,70,220,18]],a:0}));
 await frame.click('#addContext');
 await page.waitForFunction(()=>window.__modelContexts.some(c=>c.structuredContent?.contextBlocks?.length===1));
 assert.equal(await page.evaluate(()=>window.__messages.length),0,'selection must not send a chat message');
 await frame.evaluate(()=>window.__selection.set({kind:'text',page:1,text:'Highlighted evidence',rects:[[30,110,220,18]],a:4}));
 await frame.click('#highlight');
 await frame.waitForFunction(()=>window.__annotations.items.some(a=>a.text==='Highlighted evidence'));
 await frame.evaluate(()=>window.__selection.set({kind:'text',page:1,text:'Commented evidence',rects:[[30,145,220,18]],a:8}));
 await frame.click('#comment');await frame.waitForSelector('#annComment',{visible:true});
 await frame.type('#annComment','Web annotation comment');await frame.$eval('#annComment',e=>e.blur());
 await frame.waitForFunction(()=>window.__annotations.items.some(a=>a.comment==='Web annotation comment'));
 const deadline=Date.now()+10000;
 while(!zotero.annotations().some(a=>a.data.annotationComment==='Web annotation comment')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.ok(zotero.annotations().some(a=>a.data.annotationComment==='Web annotation comment'),'comment persisted to Zotero API');
 const notes=await client.callTool({name:'list_annotations',arguments:{readerSession:session,docId:doc.id}});
 assert.ok(JSON.stringify(notes).includes('Web annotation comment'),'model can read UI comment');
 const body=await client.callTool({name:'read_pages',arguments:{readerSession:session,docId:doc.id,from:1,to:1}});
 assert.ok(!body.isError,JSON.stringify(body));
 await frame.evaluate(()=>{window.__reader.scrollToPage(Math.min(2,window.__reader.doc.pageCount));window.__reader.zoomBy(1.2);});
 assert.ok(calls.length>10);assert.ok(calls.every(c=>c.arguments.readerSession===session));
 assert.ok(!calls.some(c=>['mineru_configure','tunnel_configure','document_file'].includes(c.name)));
 await mkdir('diagnostics',{recursive:true});await page.screenshot({path:'diagnostics/remote-reader.png'});
 assert.deepEqual(errors,[]);if(process.env.TEST_REMOTE_FAIL_ONCE==='1'){assert.ok(injected);assert.ok(calls.filter(c=>c.name==='render_page').length>=2);assert.equal(await frame.evaluate(()=>window.__reader.imageStats.failed),0);}
 console.log(JSON.stringify({pass:true,checks:['resource-linked reader_open','empty library search','PDF rendering through remote MCP','embedded fonts','standard web host bridge','inline/fullscreen toggle','session-scoped calls','context without chat submission','highlight persistence','comment persistence','model reads user annotations','page text read','zoom and navigation','credentials hidden'],calls:calls.length}));
}finally{
 await browser?.close();if(http)await new Promise(r=>http.close(r));await client.close();await transport.close();if(native){native.kill();await new Promise(r=>native.exitCode!==null?r():native.once('exit',r));}await zotero.close();await rm(root,{recursive:true,force:true});
}
