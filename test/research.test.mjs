import test from 'node:test';
import assert from 'node:assert/strict';
import { Research } from '../src/server/research.mjs';
import { researchContent } from '../src/shared/research.mjs';
import { Documents } from '../src/server/documents.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture({allowed=true}={}) {
  const docs=new Map(Array.from({length:5},(_,i)=>[`PAPER00${i+1}`,{id:`doc${i+1}`,itemKey:`PAPER00${i+1}`,title:`Paper ${i+1}`,pageCount:1}]));
  const releases=new Map();let active=0,maxActive=0,calls=0;
  const analysis={jobs:new Map(),status:async doc=>({complete:analysis.jobs.get(doc.id)?.state==='done',settings:{allowModelOcr:allowed},job:analysis.jobs.get(doc.id),version:'v1'}),
    async start(doc){calls++;active++;maxActive=Math.max(active,maxActive);const job={state:'running'};job.promise=new Promise(resolve=>releases.set(doc.id,()=>{job.state='done';active--;resolve();}));analysis.jobs.set(doc.id,job);},
    async cancel(doc){analysis.jobs.get(doc.id).state='cancelled';releases.get(doc.id)?.();}};
  const annotations={list:async()=>({items:[{key:'ANN00001',page:1,pageLabel:'1',rects:[[1,2,3,4]],type:'highlight',color:'#ff0',tags:['重点'],text:'selected original',comment:'my comment '.repeat(500)}]})};
  const research=new Research({resolve:async key=>{if(!docs.has(key))throw Error('missing');return docs.get(key);},analysis,annotations,renderer:{preview:async()=>({data:'aW1n'})},search:async()=>[],recent:async()=>[]});
  return {research,analysis,releases,stats:()=>({calls,maxActive})};
}
const settle=()=>new Promise(r=>setTimeout(r,10));

test('research metadata and previews do not start OCR; full comments paginate without loss',async()=>{
  const {research,stats}=fixture();
  const status=await research.status(['PAPER001','PAPER002']);
  assert.equal(status.papers.length,2);assert.equal(status.papers[0].commentCount,1);
  assert.equal((await research.preview('PAPER001')).image,'data:image/png;base64,aW1n');assert.equal(stats().calls,0);
  let offset=0,body='';const first=await research.annotationText('PAPER001',{maxChars:100});
  do{const r=await research.annotationText('PAPER001',{offset,maxChars:100,version:first.version});body+=r.text.split('\n\n').slice(1).join('\n\n');offset=r.nextOffset;}while(offset!==null);
  assert.ok(body.includes('my comment '.repeat(500)));assert.equal(stats().calls,0);
  assert.equal((await research.annotationText('PAPER001',{version:'old'})).status,'changed');
});

test('batch OCR is bounded to two jobs, reuses overlap and reports per-paper completion',async()=>{
  const {research,releases,stats}=fixture();
  const a=await research.start(['PAPER001','PAPER002','PAPER003']);await settle();
  assert.equal(stats().calls,2);
  const b=await research.start(['PAPER001']);await settle();assert.equal(stats().calls,2);
  releases.get('doc1')();await settle();assert.equal(stats().calls,3);
  releases.get('doc2')();releases.get('doc3')();await settle();
  assert.equal((await research.batch(a.batchId)).complete,true);assert.equal((await research.batch(b.batchId)).tasks[0].state,'done');
  await research.start(['PAPER001']);assert.equal(stats().calls,3);assert.equal(stats().maxActive,2);
});

test('OCR permission blocks uploads, partial errors stay visible, and an explicit request is scoped',async()=>{
  const {research,stats,releases}=fixture({allowed:false});
  const blocked=await research.start(['PAPER001','BADKEY01']);assert.equal(blocked.tasks[0].state,'blocked');assert.equal(blocked.tasks[1].state,'failed');assert.equal(stats().calls,0);
  const explicit=await research.start(['PAPER001'],{userRequested:true});await settle();assert.equal(stats().calls,1);releases.get('doc1')();await settle();
  assert.equal((await research.batch(explicit.batchId)).tasks[0].state,'done');
});

test('cancelling one shared batch preserves another subscriber; cancelled queued jobs never start',async()=>{
  const {research,releases,stats}=fixture();
  const a=await research.start(['PAPER001','PAPER002','PAPER003']);await settle();
  const b=await research.start(['PAPER001']);
  await research.cancel(a.batchId);assert.equal((await research.batch(a.batchId)).tasks[0].state,'cancelled');
  releases.get('doc1')();await settle();assert.equal((await research.batch(b.batchId)).tasks[0].state,'done');assert.equal(stats().calls,2);
});

test('research context contains references and retrieval policy, not annotation or full-text bodies',()=>{
  const blocks=researchContent({objective:'比较方法',includeAnnotations:true,papers:[{itemKey:'PAPER001',docId:'abc',title:'Paper',fullText:{available:true,version:'v1'}}]},true);
  assert.equal(blocks[0]._meta['zotero/paperKey'],'PAPER001');assert.match(blocks[0].text,/research_ocr_start/);assert.match(blocks[0].text,/research_annotations/);assert.match(blocks[0].text,/比较方法/);
});

test('background duplicate PDFs preserve the active document identity',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-doc-'));
  try{
    const data=Buffer.from('%PDF-1.0 test');const path=join(root,'test.pdf');await writeFile(path,data);
    const id=createHash('sha256').update(data).digest('hex').slice(0,16);
    const docs=new Documents({pool:{},cacheRoot:root});
    const active={id,title:'Active',itemKey:'PAPER001',attachmentKey:'ATTACH01'};docs.byId.set(id,active);
    const background=await docs.open({path,title:'Research',itemKey:'PAPER002',attachmentKey:'ATTACH02'},{background:true});
    assert.equal(background.itemKey,'PAPER002');assert.equal(docs.get(id).itemKey,'PAPER001');assert.equal(docs.get(id).title,'Active');
  }finally{await rm(root,{recursive:true,force:true});}
});
