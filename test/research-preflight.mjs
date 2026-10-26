import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync,strToU8 } from 'fflate';
import puppeteer from 'puppeteer-core';
import { fakeZotero } from './fake-zotero.mjs';
const pdf=process.argv[process.argv.indexOf('--pdf')+1];if(!process.argv.includes('--pdf'))throw Error('Pass --pdf');
const root=await mkdtemp(join(tmpdir(),'zotero-research-')),second=join(root,'second.pdf');
await writeFile(second,Buffer.concat([await readFile(pdf),Buffer.from('\n%research second\n')]));
const zotero=await fakeZotero({pdf,title:'Study One',papers:[{key:'PAPER002',attachment:'ATTACH02',title:'Study Two',pdf:second}],annotations:[{key:'ANNOT001',annotationType:'highlight',annotationText:'Highlighted evidence',annotationComment:'LONG COMMENT '.repeat(200),annotationColor:'#ffd400',annotationPageLabel:'1',annotationPosition:JSON.stringify({pageIndex:0,rects:[[10,10,100,30]]}),annotationSortIndex:'00000|000000|00300'}]});
let cloudBase,submits=0,uploads=0;
const cloud=createServer(async(req,res)=>{
  if(req.url==='/api/v4/file-urls/batch'){for await(const c of req){}const id=String(++submits);res.end(JSON.stringify({code:0,data:{batch_id:id,file_urls:[`${cloudBase}/upload/${id}`]}}));}
  else if(req.url.startsWith('/upload/')){for await(const c of req){}uploads++;res.end();}
  else if(req.url.startsWith('/api/v4/extract-results/batch/'))res.end(JSON.stringify({code:0,data:{extract_result:[{state:'done',full_zip_url:`${cloudBase}/result.zip`}]}}));
  else if(req.url==='/result.zip')res.end(zipSync({'test_content_list.json':strToU8(JSON.stringify([{type:'text',text:'Research OCR complete',bbox:[0,0,900,900],page_idx:0}]))}));
  else{res.statusCode=404;res.end();}
});
await new Promise(r=>cloud.listen(0,'127.0.0.1',r));cloudBase=`http://127.0.0.1:${cloud.address().port}`;
const server=spawn(process.execPath,['out/plugin/dist/server.mjs','--standalone','--item','PAPER001'],{env:{...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache'),CODEX_ZOTERO_API:zotero.url,CODEX_ZOTERO_MINERU_API:cloudBase+'/api/v4/',MINERU_API_KEY:'test-only-key',CODEX_ZOTERO_FAST:'1'},stdio:['ignore','ignore','pipe']});
const url=await new Promise((resolve,reject)=>{let log='';server.stderr.on('data',c=>{log+=c;const m=log.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});server.on('exit',()=>reject(Error(log)));});
const model=async(name,args={})=>(await fetch(url.replace('/panel','/api/model'),{method:'POST',body:JSON.stringify({name,arguments:args})})).json();
let browser;
try{
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,defaultViewport:{width:1100,height:900}});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluateOnNewDocument(()=>{window.__webTools={};Object.defineProperty(document,'modelContext',{configurable:true,value:{registerTool:t=>window.__webTools[t.name]=t,unregisterTool:name=>delete window.__webTools[name]}});});
  await page.goto(url.replace('/panel','/host'));await page.waitForSelector('iframe');const frame=await(await page.$('iframe')).contentFrame();await frame.waitForFunction(()=>window.__reader?.doc);
  await page.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent.annotations?.comments===1);
  assert.ok(!JSON.stringify(await page.evaluate(()=>window.__modelContexts.at(-1))).includes('LONG COMMENT'));
  const original=await frame.evaluate(()=>window.__reader.doc.id);
  await frame.click('#researchButton');await frame.type('#researchSearch','Study');await frame.click('#researchSearchButton');
  await frame.waitForFunction(()=>document.querySelectorAll('#researchResults li').length===2);
  await frame.waitForFunction(()=>document.querySelectorAll('#researchResults img').length===2);
  const history=await (await fetch(url.replace('/panel','/api/call'),{method:'POST',body:JSON.stringify({name:'home_list',arguments:{query:''}})})).json();
  assert.equal(history.recent.length,1,'search thumbnails must not mark unseen papers as read');
  await frame.click('#researchNative');
  await frame.waitForFunction(()=>document.getElementById('researchNotice').textContent.includes('当前宿主'));
  await frame.click('#researchResults li .research-cover');await frame.waitForSelector('#researchPreview:not([hidden])');
  assert.equal(await frame.evaluate(()=>window.__reader.doc.id),original);await frame.click('#researchPreviewClose');
  await frame.click('#researchResults li:nth-child(1) input');await frame.click('#researchResults li:nth-child(2) input');
  await page.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent.research.papers.length===2);
  await frame.$eval('#researchGoal',n=>{n.value='比较方法和实验';n.dispatchEvent(new Event('input'));});
  await frame.click('#researchUse');await page.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent.research.objective==='比较方法和实验');
  assert.equal(uploads,0);assert.equal(await page.evaluate(()=>window.__messages.length),0);
  const status=await model('research_status',{itemKeys:['PAPER001','PAPER002']});assert.equal(status.papers.length,2);assert.equal(status.papers[0].annotationCount,1);assert.equal(status.papers[0].commentCount,1);
  assert.equal(new Set(status.papers.map(p=>p.docId)).size,2);
  const oldRevision=await page.evaluate(()=>window.__modelContexts.at(-1).structuredContent.annotations.version);
  zotero.edit('ANNOT001',{annotationComment:'LONG COMMENT '.repeat(200)+' updated comment'});
  await page.waitForFunction(old=>window.__modelContexts.at(-1)?.structuredContent.annotations.version!==old,{},oldRevision);
  const annotations=await model('research_annotations',{itemKey:'PAPER001'});assert.ok(annotations.text.includes('LONG COMMENT '.repeat(200)));assert.ok(annotations.text.includes('updated comment'));
  const batch=await model('research_ocr_start',{itemKeys:['PAPER001','PAPER002']});assert.ok(batch.batchId,JSON.stringify(batch));
  let done;for(let i=0;i<100;i++){done=await model('research_ocr_status',{batchId:batch.batchId});if(done.complete)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(done.complete,true);assert.ok(done.tasks.every(t=>t.state==='done'),JSON.stringify(done));assert.equal(uploads,2);
  for(const p of status.papers){const text=await model('paper_full_text',{docId:p.docId});assert.match(text.text,/Research OCR complete/);}
  await model('research_ocr_start',{itemKeys:['PAPER001','PAPER002']});assert.equal(uploads,2);
  const liveText=JSON.parse(await frame.evaluate(()=>window.__webTools.reader_read_full_text.execute({maxChars:1000})));
  assert.ok(liveText.content[0].text.includes('Research OCR complete'));
  assert.ok(!Object.hasOwn(liveText.structuredContent,'text'));
  const liveAnnotations=JSON.parse(await frame.evaluate(()=>window.__webTools.reader_read_annotations.execute({})));
  assert.ok(liveAnnotations.content[0].text.includes('updated comment'));
  const liveOther=JSON.parse(await frame.evaluate(()=>window.__webTools.reader_research_full_text.execute({itemKey:'PAPER002'})));
  assert.ok(liveOther.content[0].text.includes('Research OCR complete'));
  const denied=JSON.parse(await frame.evaluate(()=>window.__webTools.reader_research_full_text.execute({itemKey:'OTHER001'})));
  assert.ok(denied.error);
  assert.equal(await frame.evaluate(()=>window.__reader.doc.id),original);
  await frame.click('#researchButton');await page.setViewport({width:375,height:812});
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'diagnostics/research-mobile.png'});
  await page.setViewport({width:1100,height:900});
  await page.evaluate(()=>{const state=window.__modelContexts.at(-1);window.__setHostContext({'openai/modelContext':{updateId:'user-removal',...state,content:state.content.filter(c=>c._meta?.['zotero/paperKey']!=='PAPER001')}});});
  await frame.waitForFunction(()=>window.__research.papers.length===1);
  const preview=await browser.newPage();await preview.goto(url.replace('/panel','/paper-preview?itemKey=PAPER001'));await preview.waitForFunction(()=>document.getElementById('image').naturalWidth>0);await preview.close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pass:true,checks:['multi-paper selection','cover thumbnails','independent page preview','goal suggestions','scoped model context','native-form fallback','no upload on selection','complete highlights and comments','annotation revision updates','batch OCR','cached result reuse','per-paper full text','live reader returns body and comments','live research scope boundary','active reader preserved','narrow viewport','host removal sync','standalone resource preview'],uploads}));
}finally{await browser?.close();server.kill();await new Promise(r=>cloud.close(r));await zotero.close();await rm(root,{recursive:true,force:true});}
