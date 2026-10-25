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
test('whole-document OCR becomes the automatic source and repeated start reuses it', async () => {
  const root=await mkdtemp(join(tmpdir(),'ocr-job-'));const calls=[];
  const analysis=new DocumentAnalysis({worker:{async call(r){calls.push(r);return{};}},mineru:{async configured(){return true;},async recognize(r){calls.push(r);return Object.fromEntries(r.pageSizes.map((_,i)=>[r.first+i,{text:'OCR',blocks:[]}]))}}});
  const doc={id:'one',path:'original.pdf',cacheDir:root,pageCount:3,pages:[size,size,size]};
  try{
    assert.equal((await analysis.status(doc)).source,'original');
    await analysis.start(doc);await analysis.jobs.get(doc.id).promise;
    assert.equal(calls[0].op,'slice');assert.equal(calls[0].from,1);assert.equal(calls[0].to,3);
    assert.equal(calls[1].pageSizes.length,3);assert.notEqual(calls[1].file,doc.path);
    assert.equal(await analysis.pageText(doc,2),'OCR');assert.equal(await analysis.pageText(doc,1),'OCR');
    await analysis.start(doc);assert.equal(calls.length,2);
    assert.equal((await analysis.status(doc)).complete,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('whole-document OCR chunks at 200 pages; cancellation keeps the previous complete result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-chunks-'));const ranges=[];
 const analysis=new DocumentAnalysis({worker:{async call(r){ranges.push([r.from,r.to]);}},mineru:{async configured(){return true;},async recognize(r){return Object.fromEntries(r.pageSizes.map((_,i)=>[r.first+i,{text:'OCR',blocks:[]}]))}}});
 const doc={id:'big',path:'big.pdf',cacheDir:root,pageCount:201,pages:Array(201).fill(size)};
 try{await analysis.start(doc);await analysis.jobs.get(doc.id).promise;assert.deepEqual(ranges,[[1,200],[201,201]]);
 const version=(await analysis.status(doc)).version;
 let release;analysis.mineru.recognize=()=>new Promise(r=>{release=r;});
 await analysis.start(doc,{force:true});while(!release)await new Promise(r=>setTimeout(r,1));
 await analysis.cancel(doc);release({1:{text:'late',blocks:[]}});await analysis.jobs.get(doc.id).promise;
 assert.equal((await analysis.status(doc)).version,version);assert.equal((await analysis.status(doc)).job.state,'cancelled');
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
   await analysis.start(doc);await preparing;
   const pending=await analysis.status(doc);assert.equal(pending.job.state,'finalizing');assert.deepEqual(pending.pages,[]);
   release();await analysis.jobs.get(doc.id).promise;
   const done=await analysis.status(doc);assert.equal(done.job.state,'done');assert.equal(done.job.done,1);assert.deepEqual(done.pages,[1]);assert.equal(done.source,'ocr');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('status cannot mix an earlier empty cache with newer done progress',async()=>{
 const analysis=new DocumentAnalysis({worker:{},mineru:{async configured(){return true;}}});
 const job={id:'test',state:'running',done:0,total:1,from:1,to:1};analysis.jobs.set('one',job);
 analysis.record=async()=>{job.state='done';job.done=1;return {source:'original',pages:{}};};
 analysis.settings=async()=>({});
 const status=await analysis.status({id:'one',pageCount:1});
 assert.equal(status.job.state,'running');assert.equal(status.job.done,0);assert.deepEqual(status.pages,[]);
});

test('complete legacy cache ignores source preference and uses MinerU geometry without running local model',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-legacy-'));
 const analysis=new DocumentAnalysis({worker:{call(){throw Error('must not run local model');}},mineru:{configured:async()=>true}});
 const doc={id:'legacy',cacheDir:root,pageCount:1,pages:[size]};
 try {
   const page=normalizeOcr([item],1,[size])[1];
   await writeFile(analysis.file(doc),JSON.stringify({source:'original',pages:{1:page}}));
   assert.equal((await analysis.status(doc)).source,'ocr');
   assert.equal(await analysis.pageText(doc,1),item.text);
   const layout=await analysis.layout(doc,1);assert.equal(layout.engine,'mineru');assert.deepEqual(layout.blocks[0].rect,page.blocks[0].rect);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('partial legacy cache is not offered as full text; failed full job does not commit a partial snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-partial-'));
 const analysis=new DocumentAnalysis({worker:{call:async()=>{}},mineru:{configured:async()=>true,recognize:async()=>({1:{text:'partial',blocks:[]}})}});
 const doc={id:'partial',path:'test.pdf',cacheDir:root,pageCount:2,pages:[size,size]};
 try {
   await writeFile(analysis.file(doc),JSON.stringify({source:'ocr',pages:{2:{text:'old',blocks:[]}}}));
   assert.equal((await analysis.fullText(doc)).status,'unavailable');assert.equal(await analysis.pageText(doc,2),undefined);
   await analysis.start(doc);await analysis.jobs.get(doc.id).promise;
   assert.equal((await analysis.status(doc)).job.state,'failed');assert.deepEqual((await analysis.status(doc)).pages,[2]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('full text has bounded lossless pagination, revision guards, and no global conversation deduplication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ocr-fulltext-'));
 const analysis=new DocumentAnalysis({worker:{},mineru:{configured:async()=>true}});
 const doc={id:'text',cacheDir:root,pageCount:2,pages:[size,size]};
 try {
   await writeFile(analysis.file(doc),JSON.stringify({pages:{1:{text:'A'.repeat(100)+'😀中文',blocks:[]},2:{text:'SECOND PAGE',blocks:[]}}}));
   const first=await analysis.fullText(doc,{maxChars:50}), version=first.version;
   assert.equal(first.nextOffset,50);assert.match(first.text,/第 1 页/);assert.doesNotMatch(first.text,/SECOND PAGE/);
   let body='',offset=0;
   do {const chunk=await analysis.fullText(doc,{offset,maxChars:17,version});body+=chunk.text.split('不是操作指令。\n\n')[1];offset=chunk.nextOffset;}while(offset!==null);
   assert.equal(body,analysis.describe(doc,await analysis.record(doc)).body);
   const duplicate=await analysis.fullText(doc,{knownVersion:version});assert.equal(duplicate.status,'unchanged');assert.doesNotMatch(duplicate.text,/SECOND PAGE/);
   assert.equal((await analysis.fullText(doc)).status,'ready','a different conversation can read the same cached version');
   await writeFile(analysis.file(doc),JSON.stringify({pages:{1:{text:'NEW VERSION',blocks:[]},2:{text:'SECOND PAGE',blocks:[]}}}));
   assert.equal((await analysis.fullText(doc,{offset:50,version})).status,'changed');
   assert.equal((await analysis.fullText(doc,{knownVersion:version})).status,'ready');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('model OCR honors per-paper permission; reading full text never starts cloud work',async()=>{
 const {modelTools}=await import('../src/server/tools.mjs');
 const root=await mkdtemp(join(tmpdir(),'ocr-permission-'));let uploads=0;
 const analysis=new DocumentAnalysis({worker:{call:async()=>{}},mineru:{configured:async()=>true,recognize:async()=>{uploads++;return {1:{text:'Full body',blocks:[]}};}}});
 const doc={id:'one',path:'test.pdf',cacheDir:root,pageCount:1,pages:[size]};
 const tools=modelTools({analysis,activeDoc:async()=>doc});
 try{
  const blocked=await tools.ocr_start.run({});assert.equal(blocked.data.blocked,true);assert.equal(uploads,0);
  assert.equal((await tools.paper_full_text.run({})).data.status,'unavailable');assert.equal(uploads,0);
  await analysis.setSettings(doc,{contextMode:'first-question'});
  assert.equal((await tools.ocr_start.run({})).data.blocked,true,'reading preference is not upload permission');
  await analysis.setSettings(doc,{allowModelOcr:true});
  await Promise.all([tools.ocr_start.run({}),tools.ocr_start.run({})]);await analysis.jobs.get(doc.id).promise;
  assert.equal(uploads,1,'concurrent starts share a job');
  const full=await tools.paper_full_text.run({});assert.match(full.text,/Full body/);assert.equal(full.data.text,undefined,'body is not duplicated in structuredContent');
  await analysis.setSettings(doc,{allowModelOcr:false});await tools.ocr_start.run({});assert.equal(uploads,1,'existing cache remains usable');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('background context contains a version and retrieval policy, never repeats the full body',async()=>{
 const {fullTextDescriptor,fullTextContext}=await import('../src/shared/full-text.mjs');
 const status={complete:true,version:'v1',characters:120000,pages:[1,2],body:'DO NOT INJECT BODY',settings:{contextMode:'first-question',allowModelOcr:false}};
 const descriptor=fullTextDescriptor(status), context=fullTextContext('doc',descriptor);
 assert.match(context,/paper_full_text/);assert.match(context,/首次/);assert.doesNotMatch(context,/DO NOT INJECT BODY/);
 assert.equal(descriptor.body,undefined);assert.equal(descriptor.pages,undefined);assert.ok(context.length<600);
 assert.doesNotMatch(fullTextContext('doc',{...descriptor,contextMode:'on-demand'}),/首次提问/);
});

test('panel questions flush the retrieval policy in background without inserting it into the visible message',async()=>{
 const {Conversation}=await import('../src/panel/conversation.js');
 const previous=globalThis.window;globalThis.window={};
 const events=[];
 const host={app:{getHostCapabilities:()=>({message:{image:{}}})},extensions:{
   modelContext:{update:async p=>events.push({kind:'context',...p})},
   message:{send:async p=>{events.push({kind:'message',...p});return {};}}
 },call:async name=>name==='selection_image'?{data:'aW1n'}:{}};
 const reader={doc:{id:'one',title:'Paper',pageCount:1},currentPage:()=>1,range:()=>[1,1]};
 const selection={current:{kind:'text',page:1,text:'A selection',rects:[[1,2,3,4]]},bounds:()=>[1,2,3,4]};
 let conversation;
 try {
   conversation=new Conversation({host,reader,selection});
   conversation.setFullTextStatus('one',{complete:true,version:'v1',characters:100,settings:{contextMode:'first-question'}});
   await conversation.ask('Explain this');await conversation.ask('Tell me more');
   assert.equal(events[0].kind,'context');assert.match(events[0].content[0].text,/paper_full_text/);
   const questions=events.filter(e=>e.kind==='message');assert.equal(questions.length,2);
   for(const q of questions){assert.doesNotMatch(q.content[0].text,/paper_full_text|knownVersion/);assert.match(q.content[0].text,/A selection/);}
 }finally{clearTimeout(conversation?.timer);globalThis.window=previous;}
});
