// Built remote App -> official AppBridge -> stdio MCP -> private socket -> real reader service.
// This emulates a web host without the desktop-only extensions. No real account or library is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeZotero } from './fake-zotero.mjs';
const pdf=process.argv[process.argv.indexOf('--pdf')+1];
if(!process.argv.includes('--pdf'))throw new Error('Pass --pdf FILE');
const root=await mkdtemp(join(tmpdir(),'zotero-web-reader-'));
const zotero=await fakeZotero({pdf,title:'Remote performance test paper'});
const env={...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache'),CODEX_ZOTERO_API:zotero.url,CODEX_ZOTERO_FAST:'1',MINERU_API_KEY:''};
const native=spawn(process.execPath,['out/plugin/dist/server.mjs','--standalone','--chat-bridge'],{env,stdio:['ignore','ignore','pipe']});
const nativeUrl=await new Promise((resolve,reject)=>{let log='';native.stderr.on('data',c=>{log+=c;const m=log.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});native.on('exit',()=>reject(new Error(log)));});
const client=new Client({name:'web-reader-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:['out/plugin/dist/chat-bridge.mjs'],env,stderr:'pipe'});
let browser,http;
const calls=[];const delayMs=Number(process.env.TEST_REMOTE_DELAY_MS||250);let lane=Promise.resolve();let startedAt=0;const samples=[];
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
   if(req.url.startsWith('/host')){res.setHeader('Content-Type','text/html');return res.end(host);}
   if(req.url==='/panel'){res.setHeader('Content-Type','text/html');return res.end(html);}
   if(req.url==='/api/tool'){
    let body='';for await(const c of req)body+=c;const args=JSON.parse(body);calls.push(args);
    const run=lane.then(async()=>{await new Promise(r=>setTimeout(r,delayMs));const result=await client.callTool(args);samples.push({name:args.name,bytes:Buffer.byteLength(JSON.stringify(result))});return result;});lane=run.catch(()=>{});res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(await run));
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
 startedAt=Date.now();
 await frame.type('#search','Remote');await frame.waitForSelector('#homeList li');await frame.click('#homeList li');
 await frame.waitForFunction(()=>window.__reader?.metrics?.openSharpMs>0,{timeout:60000});
 const first=await frame.evaluate(()=>({sharpMs:window.__reader.metrics.openSharpMs,loaded:window.__reader.imageStats.loaded,failed:window.__reader.imageStats.failed}));
 const counts=Object.fromEntries([...new Set(calls.map(c=>c.name))].map(n=>[n,calls.filter(c=>c.name===n).length]));
 await mkdir('diagnostics',{recursive:true});await page.screenshot({path:'diagnostics/remote-performance.png'});
 const image=await frame.evaluate(()=>{const i=document.querySelector('.page img[src]');return {mime:i?.src.split(';')[0],width:i?.naturalWidth,height:i?.naturalHeight};});
 const metrics={pass:true,image,delayMs,elapsedMs:Date.now()-startedAt,...first,calls:calls.length,counts,bytes:samples.reduce((a,x)=>a+x.bytes,0)};
 if(image.mime==='data:image/webp'){
  const id=await frame.evaluate(()=>window.__reader.doc.id),dir=join(env.CODEX_ZOTERO_CACHE,id);
  const webp=(await readdir(dir)).find(f=>f.endsWith('.webp'));
  const equal=execFileSync(env.CODEX_ZOTERO_PYTHON,['-c','from PIL import Image;import sys;print(Image.open(sys.argv[1]).convert("RGBA").tobytes()==Image.open(sys.argv[2]).convert("RGBA").tobytes())',join(dir,webp.slice(0,-5)),join(dir,webp)],{encoding:'utf8'}).trim();
  assert.equal(equal,'True');metrics.losslessPixels=true;
 }
 const pages=await frame.evaluate(()=>window.__reader.doc.pageCount);
 if(pages>1){
  await frame.evaluate(()=>window.__reader.scrollToPage(2));
  await frame.waitForFunction(()=>window.__reader.pages.get(2)?.strips.size&&[...window.__reader.pages.get(2).strips.values()].some(s=>s.ready),{timeout:30000});
 }
 await frame.evaluate(()=>window.__reader.zoomBy(1.2));
 await frame.waitForFunction(()=>window.__reader.visibleKeys?.every(k=>window.__reader.pages.get(Number(k.split('|')[0]))?.strips.get(k)?.ready),{timeout:30000});
 await frame.evaluate(()=>window.__reader.toggleCrop());
 await frame.waitForFunction(()=>window.__reader.visibleKeys?.every(k=>window.__reader.pages.get(Number(k.split('|')[0]))?.strips.get(k)?.ready),{timeout:30000});
 assert.deepEqual(errors,[]);metrics.navigationZoomCrop=true;
 console.log(JSON.stringify(metrics));
}finally{
 await browser?.close();if(http)await new Promise(r=>http.close(r));await client.close();await transport.close();native.kill();await new Promise(r=>native.exitCode!==null?r():native.once('exit',r));await zotero.close();await rm(root,{recursive:true,force:true});
}
