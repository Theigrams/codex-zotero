// End-to-end layout/context/OCR test: real local model, isolated reader state, fake MinerU.
// node test/analysis-preflight.mjs --pdf /path/to/paper.pdf
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import puppeteer from 'puppeteer-core';
const pdf = process.argv[process.argv.indexOf('--pdf')+1];
if (!process.argv.includes('--pdf')) throw new Error('Pass --pdf FILE');
const root = await mkdtemp(join(tmpdir(),'zotero-analysis-e2e-'));
let base, submits=0, uploads=0, downloads=0, releaseDownload, pageCount=1;
const cloud=createServer(async(req,res)=>{
 if(req.url==='/api/v4/file-urls/batch'){submits++;let body='';for await(const c of req)body+=c;const data=JSON.parse(body);assert.equal(data.files[0].is_ocr,true);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data:{batch_id:'test',file_urls:[base+'/upload']}}));}
 else if(req.url==='/upload'){for await(const c of req){}uploads++;res.end();}
 else if(req.url==='/api/v4/extract-results/batch/test'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data:{extract_result:[{state:'done',full_zip_url:base+'/result.zip'}]}}));}
 else if(req.url==='/result.zip'){const send=()=>res.end(zipSync({'test_content_list.json':strToU8(JSON.stringify(Array.from({length:pageCount},(_,i)=>({type:'text',text:`Verified OCR result page ${i+1}`,bbox:[0,0,900,900],page_idx:i}))))}));if(++downloads===1)releaseDownload=send;else send();}
 else{res.statusCode=404;res.end();}
});
await new Promise(r=>cloud.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${cloud.address().port}`;
const server=spawn(process.execPath,['out/plugin/dist/server.mjs','--standalone','--pdf',pdf],{env:{...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache'),CODEX_ZOTERO_MINERU_API:base+'/api/v4/',MINERU_API_KEY:'test-only'},stdio:['ignore','ignore','pipe']});
const url=await new Promise((resolve,reject)=>{let text='';server.stderr.on('data',c=>{text+=c;const m=text.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});server.on('exit',()=>reject(new Error(text)));});
let browser;
try {
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,defaultViewport:{width:1100,height:900,deviceScaleFactor:2}});
 const host=await browser.newPage();await host.goto(url.replace('/panel','/host'));await host.waitForSelector('iframe');
 const frame=await (await host.$('iframe')).contentFrame();
 await frame.waitForFunction(()=>window.__reader?.doc&&[...window.__blocks.pages.values()].some(v=>v?.blocks?.length),{timeout:45000});
 assert.equal(submits,0,'opening/layout must never upload');
 const result=await frame.evaluate(()=>{const v=[...window.__blocks.pages.values()][0];return {engine:v.engine,blocks:v.blocks.length};});
 assert.equal(result.engine,'pp-doclayout-v2');assert.ok(result.blocks>0);
 // Select an actual detected block, then add it through the user control.
 await frame.evaluate(()=>{const b=[...window.__blocks.pages.values()][0].blocks.find(x=>x.type==='text')||[...window.__blocks.pages.values()][0].blocks[0];window.__blocks.select(1,[b.rect[0]+b.rect[2]/2,b.rect[1]+b.rect[3]/2]);});
 await frame.click('#addContext');
 await host.waitForFunction(()=>window.__modelContexts?.at(-1)?.structuredContent?.contextBlocks?.length===1,{timeout:5000});
 const context=await host.evaluate(()=>window.__modelContexts.at(-1));
 assert.equal(context.content[1]._meta['openai/group'].title,context.structuredContent.document.title);
 assert.ok(context.content[1]._meta['openai/thumbnail'].src.startsWith('data:image/png;base64,'));
 assert.deepEqual(context.content[0].annotations.audience,['assistant']);
 if(process.argv.includes('--screenshot')) await host.screenshot({path:process.argv[process.argv.indexOf('--screenshot')+1]});
 await host.evaluate(()=>window.__clearModelContext());await frame.waitForFunction(()=>window.__contexts.items.length===0);
 pageCount=await frame.evaluate(()=>window.__reader.doc.pageCount);
 const model=async(name,args={})=>(await fetch(url.replace('/panel','/api/model'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})})).json();
 assert.equal((await model('ocr_start')).data.blocked,true);assert.equal(submits,0);
 await frame.click('#ocrButton');await frame.waitForFunction(()=>!document.getElementById('ocrDocument').disabled);
 assert.equal(await frame.$('#ocrPage'),null);assert.equal(await frame.$('#ocrSource'),null);
 await frame.select('#ocrContextMode','first-question');
 await host.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent?.fullText?.contextMode==='first-question');
 assert.equal((await model('ocr_start')).data.blocked,true,'context choice does not authorize uploads');
 await frame.click('#ocrDocument');
 await frame.waitForFunction(()=>document.getElementById('ocrStatus').textContent.includes('正在下载识别结果'),{timeout:10000});
 assert.equal(await frame.$eval('#ocrDocument',el=>el.disabled),true,'download still counts as busy');
 assert.equal((await model('paper_full_text')).data.status,'unavailable');
 releaseDownload();
 await frame.waitForFunction(()=>document.getElementById('ocrStatus').textContent.includes('识别完成'),{timeout:15000});
 assert.equal(submits,1);assert.equal(uploads,1);
 await frame.waitForFunction(()=>[...window.__blocks.pages.values()].some(v=>v?.engine==='mineru'));
 assert.match(await frame.$eval('#ocrCached',el=>el.textContent),/自动使用/);
 await host.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent?.fullText?.available===true);
 const pointer=await host.evaluate(()=>window.__modelContexts.at(-1));
 assert.ok(pointer.content[0].text.includes('paper_full_text'));
 assert.equal(JSON.stringify(pointer).includes('Verified OCR result'),false,'full text never lives in the repeating context');
 const first=await model('paper_full_text');assert.equal(first.data.status,'ready');assert.ok(first.text.includes(`Verified OCR result page ${pageCount}`));
 const repeat=await model('paper_full_text',{knownVersion:first.data.version});assert.equal(repeat.data.status,'unchanged');assert.ok(!repeat.text.includes('Verified OCR result'));
 assert.equal((await model('paper_full_text')).data.status,'ready','fresh conversation can still retrieve');
 await model('ocr_start');assert.equal(submits,1,'complete result prevents a second cloud job');
 await frame.click('#ocrAllowModel');await frame.waitForFunction(()=>window.__ocr.status.settings.allowModelOcr===true);
 await frame.click('#ocrDocument');await frame.waitForFunction(()=>!document.getElementById('ocrDocument').disabled,{timeout:15000});
 assert.equal(submits,2,'only explicit re-recognition forces another job');
 if(process.argv.includes('--screenshot')) await host.screenshot({path:process.argv[process.argv.indexOf('--screenshot')+1]});
 await frame.click('#ocrClose');await frame.click('#layoutButton');await frame.waitForFunction(()=>document.getElementById('layoutButton').getAttribute('aria-pressed')==='false');
 await frame.click('#layoutButton');await frame.waitForFunction(()=>document.getElementById('layoutButton').getAttribute('aria-pressed')==='true');
 // A narrow panel still exposes the controls and keeps context text in its own scroller.
 await host.setViewport({width:420,height:740});
 assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 console.log(JSON.stringify({pass:true,layout:result,checks:['no automatic cloud request','local model','block context thumbnail/group','host removal synchronization','download completion waits for usable local results','single-page/source controls removed','whole-document atomic source','compact first-question policy','full text retrieval and version deduplication','per-paper model OCR permission','layout toggle','narrow panel'],cloudRequests:submits}));
}finally{await browser?.close();server.kill();await new Promise(r=>cloud.close(r));await rm(root,{recursive:true,force:true});}
