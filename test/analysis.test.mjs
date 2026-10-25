import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { DocumentAnalysis } from '../src/server/analysis.mjs';
import { MinerU, normalizeOcr, readOcrZip } from '../src/server/mineru.mjs';
import { contextContent } from '../src/shared/context-blocks.mjs';
import { State } from '../src/server/state.mjs';

const size = { width: 600, height: 800 };
const item = { type:'text', text:'Recognized paragraph', bbox:[100,200,500,300], page_idx:0 };
const zip = () => zipSync({ 'result_content_list.json':strToU8(JSON.stringify([item])), '../outside.json':strToU8('{}') });

test('OCR slice mapping uses original page numbers and normalizes 0..1000 boxes', () => {
  const pages = normalizeOcr([item], 7, [size]);
  assert.equal(pages[7].text, item.text);
  assert.deepEqual(pages[7].blocks[0].rect, [60,160,240,80]);
  assert.equal(pages[1],undefined);
});
test('OCR ignores invalid geometry and preserves formula text and tables safely', () => {
  const result = normalizeOcr([
    { ...item, type:'equation', text:'E = mc^2' },
    { ...item, type:'table', text:undefined, table_body:'<table><tr><td>A</td><td>B</td></tr></table><script>x</script>' },
    { ...item, text:'valid text', bbox:[NaN,0,1,1] },
  ],1,[size])[1];
  assert.equal(result.blocks[0].type,'formula');
  assert.match(result.text,/E = mc\^2/); assert.match(result.text,/A \| B/); assert.doesNotMatch(result.text,/<script>/);
  assert.equal(result.blocks.length,2);
});
test('OCR supports legacy PDF-point geometry and safely reads ZIP in memory', () => {
  const p=normalizeOcr({pdf_info:[{page_idx:0,para_blocks:[{type:'text',bbox:[10,20,100,40],lines:[{spans:[{content:'legacy'}]}]}]}]},4,[size]);
  assert.deepEqual(p[4].blocks[0].rect,[10,20,90,20]);
  assert.equal(readOcrZip(zip(),1,[size])[1].text,item.text);
  assert.throws(()=>normalizeOcr({},1,[size]),/未支持/);
});
test('layout is local, deduplicated, and never starts OCR', async () => {
  const root=await mkdtemp(join(tmpdir(),'layout-test-'));let calls=0;
  const analysis=new DocumentAnalysis({worker:{async call(){calls++;return {engine:'pp-doclayout-v2',blocks:[{id:'0',type:'text',text:'native',rect:[10,10,80,20]}]};}},mineru:{recognize(){throw Error('must not upload');}}});
  const doc={id:'one',cacheDir:root,path:'paper.pdf',pageCount:1,pages:[size]};
  try { const [a,b]=await Promise.all([analysis.layout(doc,1),analysis.layout(doc,1)]);assert.equal(calls,1);assert.equal(a.blocks[0].text,b.blocks[0].text); } finally {await rm(root,{recursive:true,force:true});}
});
test('explicit single-page OCR slices before upload and preserves previous page cache', async () => {
  const root=await mkdtemp(join(tmpdir(),'ocr-job-'));const calls=[];
  const analysis=new DocumentAnalysis({worker:{async call(r){calls.push(r);return{};}},mineru:{async configured(){return true;},async recognize(r){calls.push(r);return {[r.first]:{text:'OCR',blocks:[]}};}}});
  const doc={id:'one',path:'original.pdf',cacheDir:root,pageCount:3,pages:[size,size,size]};
  try{
    assert.equal((await analysis.status(doc)).source,'original');
    await analysis.start(doc,{scope:'page',page:2});await analysis.jobs.get(doc.id).promise;
    assert.equal(calls[0].op,'slice');assert.equal(calls[0].from,2);assert.equal(calls[0].to,2);
    assert.equal(calls[1].pageSizes.length,1);assert.notEqual(calls[1].file,doc.path);
    assert.equal(await analysis.pageText(doc,2),'OCR');assert.equal(await analysis.pageText(doc,1),undefined);
    await analysis.setSource(doc,'original');assert.equal(await analysis.pageText(doc,2),undefined);
    await analysis.start(doc,{scope:'page',page:3});await analysis.jobs.get(doc.id).promise;
    assert.deepEqual((await analysis.status(doc)).pages,[2,3]);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('whole-document OCR chunks at 200 pages and cancellation does not apply late results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-chunks-'));const ranges=[];
 const analysis=new DocumentAnalysis({worker:{async call(r){ranges.push([r.from,r.to]);}},mineru:{async configured(){return true;},async recognize(r){return {[r.first]:{text:'OCR',blocks:[]}};}}});
 const doc={id:'big',path:'big.pdf',cacheDir:root,pageCount:201,pages:Array(201).fill(size)};
 try{await analysis.start(doc,{scope:'document',page:1});await analysis.jobs.get(doc.id).promise;assert.deepEqual(ranges,[[1,200],[201,201]]);
 let release;analysis.mineru.recognize=()=>new Promise(r=>{release=r;});
 await analysis.start(doc,{scope:'page',page:2});while(!release)await new Promise(r=>setTimeout(r,1));
 await analysis.cancel(doc);release({2:{text:'late',blocks:[]}});await analysis.jobs.get(doc.id).promise;
 assert.equal((await analysis.record(doc)).pages[2],undefined);assert.equal((await analysis.status(doc)).job.state,'cancelled');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('MinerU transport keeps auth only on API calls and requests forced OCR',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mineru-client-'));const file=join(dir,'one.pdf');await writeFile(file,'%PDF-test');const requests=[];
 const client=new MinerU({secretFile:join(dir,'secret.json'),sleep:async()=>{},fetchImpl:async(url,options)=>{
   requests.push({url,options});
   if(url.endsWith('file-urls/batch'))return Response.json({code:0,data:{batch_id:'batch',file_urls:['https://upload.example/a']}});
   if(url==='https://upload.example/a')return new Response('');
   if(url.includes('extract-results'))return Response.json({code:0,data:{extract_result:[{state:'done',full_zip_url:'https://download.example/a.zip'}]}});
   return new Response(zip());
 }});
 await writeFile(join(dir,'secret.json'),JSON.stringify({apiKey:'test-secret'}));
 try{const r=await client.recognize({file,first:1,pageSizes:[size],signal:new AbortController().signal,progress:()=>{}});assert.equal(r[1].text,item.text);
 const body=JSON.parse(requests[0].options.body);assert.equal(body.files[0].is_ocr,true);assert.equal(body.model_version,'vlm');
 assert.equal(requests[1].options.headers,undefined);assert.equal(requests[3].options.headers,undefined);
 assert.doesNotMatch(JSON.stringify(r),/test-secret/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('layout preference defaults on and persists without enabling OCR',async()=>{
 const root=await mkdtemp(join(tmpdir(),'layout-pref-'));try{const s=new State(root);assert.equal((await s.prefs()).layoutEnabled,true);await s.setPrefs({layoutEnabled:false});assert.equal((await s.prefs()).layoutEnabled,false);assert.equal((await s.prefs()).ocrEnabled,undefined);}finally{await rm(root,{recursive:true,force:true});}
});
test('context blocks retain page/type/source and support extended and portable hosts',()=>{
 const block={id:'p1',docId:'doc',title:'Paper',page:4,type:'formula',source:'ocr',rect:[1,2,3,4],text:'E=mc^2',image:'aW1n'};
 const extended=contextContent('position',[block],{extended:true,images:true});
 assert.deepEqual(extended[0].annotations.audience,['assistant']);assert.equal(extended[1]._meta['openai/title'],'第 4 页 · 公式');assert.equal(extended[2].type,'image');assert.match(extended[1].text,/MinerU OCR/);
 const fallback=contextContent('position',[block]);assert.equal(fallback.length,2);assert.equal(fallback[1]._meta,undefined);assert.match(fallback[1].text,/E=mc\^2/);
});

test('current MinerU content-list v2 preserves nested paragraph and title content',()=>{
 const out=normalizeOcr([[{type:'title',content:{title_content:[{type:'text',content:'Title'}]},bbox:[0,0,100,100]},{type:'paragraph',content:{paragraph_content:[{type:'text',content:'Actual OCR text'}]},bbox:[0,100,100,200]}]],1,[size]);
 assert.match(out[1].text,/Title/);assert.match(out[1].text,/Actual OCR text/);
});

test('model reads and searches selected OCR while native glyph positions stay intact',async()=>{
 const {Paper,plainText}=await import('../src/server/paper.mjs');
 const native={t:['Native text'],b:[0,0,10,10],l:[0],fullText:'OCR-only phrase'};
 assert.equal(plainText(native),'OCR-only phrase');
 const paper=new Paper({page:async()=>native});const doc={pageCount:1,pages:[{label:'1'}]};
 assert.equal((await paper.read(doc,1))[0].text,'OCR-only phrase');
 assert.equal((await paper.find(doc,'OCR-only'))[0].source,'ocr');
 assert.deepEqual(native.b,[0,0,10,10]);
});

test('remote done stays downloading until the ZIP is available', async () => {
 const dir=await mkdtemp(join(tmpdir(),'mineru-download-'));
 const file=join(dir,'one.pdf');await writeFile(file,'%PDF-test');
 const secretFile=join(dir,'secret.json');await writeFile(secretFile,JSON.stringify({apiKey:'test-secret'}));
 const states=[];let release, downloading;
 const requested=new Promise(resolve=>{downloading=resolve;});
 const client=new MinerU({secretFile,fetchImpl:async(url)=>{
   if(url.endsWith('file-urls/batch'))return Response.json({code:0,data:{batch_id:'test',file_urls:['https://upload.example/a']}});
   if(url==='https://upload.example/a')return new Response('');
   if(url.includes('extract-results'))return Response.json({code:0,data:{extract_result:[{state:'done',full_zip_url:'https://download.example/a.zip'}]}});
   downloading();return new Promise(resolve=>{release=()=>resolve(new Response(zip()));});
 }});
 try {
   const task=client.recognize({file,first:1,pageSizes:[size],signal:new AbortController().signal,progress:state=>states.push(state)});
   await requested;assert.equal(states.at(-1),'downloading');assert.ok(!states.includes('done'));
   release();assert.equal((await task)[1].text,item.text);assert.equal(states.at(-1),'finalizing');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('OCR completion is published only after parsed results are cached',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-finalize-'));let release, ready;
 const preparing=new Promise(resolve=>{ready=resolve;});
 const analysis=new DocumentAnalysis({worker:{async call(){}},mineru:{async configured(){return true;},async recognize({progress}){
   progress('done');ready();return new Promise(resolve=>{release=()=>resolve({1:{text:'ready',blocks:[]}});});
 }}});
 const doc={id:'one',path:'one.pdf',cacheDir:root,pageCount:1,pages:[size]};
 try{
   await analysis.start(doc,{scope:'page',page:1});await preparing;
   const pending=await analysis.status(doc);assert.equal(pending.job.state,'finalizing');assert.deepEqual(pending.pages,[]);
   release();await analysis.jobs.get(doc.id).promise;
   const done=await analysis.status(doc);assert.equal(done.job.state,'done');assert.equal(done.job.done,1);assert.deepEqual(done.pages,[1]);assert.equal(done.source,'ocr');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('status cannot mix an earlier empty cache with newer done progress',async()=>{
 const analysis=new DocumentAnalysis({worker:{},mineru:{async configured(){return true;}}});
 const job={id:'test',state:'running',done:0,total:1,from:1,to:1};analysis.jobs.set('one',job);
 analysis.record=async()=>{job.state='done';job.done=1;return {source:'original',pages:{}};};
 const status=await analysis.status({id:'one'});
 assert.equal(status.job.state,'running');assert.equal(status.job.done,0);assert.deepEqual(status.pages,[]);
});
