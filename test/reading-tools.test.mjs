import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTools } from '../src/server/tools.mjs';
import { researchTools } from '../src/server/research.mjs';
import { modelToolMetadata, modelToolResult } from '../src/server/tool-policy.mjs';
import { registerReadingTools } from '../src/panel/reading-tools.js';

test('every public operation has explicit visibility and all three safety annotations',()=>{
  for(const name of Object.keys({...modelTools({}),...researchTools({})})) {
    const metadata=modelToolMetadata(name);
    assert.deepEqual(metadata._meta.ui.visibility,['model','app']);
    for(const key of ['readOnlyHint','destructiveHint','openWorldHint'])assert.equal(typeof metadata.annotations[key],'boolean',`${name}.${key}`);
  }
  for(const name of ['read_pages','paper_full_text','research_annotations','reader_state'])assert.deepEqual(modelToolMetadata(name).annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
  assert.equal(modelToolMetadata('ocr_start').annotations.readOnlyHint,false);
  assert.equal(modelToolMetadata('delete_annotation').annotations.destructiveHint,true);
  assert.throws(()=>modelToolMetadata('unknown_operation'),/Missing/);
});

test('live reading tools preserve the actual content body and enforce the current selection boundary',async()=>{
  const registered={},calls=[];
  const body='Actual paper body — not metadata';
  const host={callTool:async(name,args)=>{
    calls.push({name,args});
    if(name==='research_status')return {content:[],structuredContent:{papers:[{docId:'selected-doc'}]}};
    return {content:[{type:'text',text:body}],structuredContent:{status:'ready',nextOffset:null}};
  }};
  registerReadingTools({register:(name,description,properties,required,execute,readOnly)=>{registered[name]={execute,readOnly};},host,
    reader:{doc:{id:'current-doc',itemKey:'PAPER001',pageCount:9},currentPage:()=>2},research:{papers:[{itemKey:'PAPER002'}]}});
  assert.equal((await registered.reader_read_full_text.execute({maxChars:150})).content[0].text,body);
  assert.equal(calls[0].name,'paper_full_text');assert.equal(calls[0].args.docId,'current-doc');
  await registered.reader_read_pages.execute({from:2,to:3});assert.equal(calls.at(-1).args.from,2);
  assert.throws(()=>registered.reader_read_pages.execute({from:10}),/页码/);
  await registered.reader_read_annotations.execute({});assert.equal(calls.at(-1).name,'research_annotations');
  await registered.reader_research_full_text.execute({itemKey:'PAPER002'});assert.equal(calls.at(-1).args.docId,'selected-doc');
  await assert.rejects(()=>registered.reader_research_full_text.execute({itemKey:'PAPER003'}),/不在/);
  assert.ok(Object.values(registered).every(tool=>tool.readOnly));
});

test('result normalization keeps full text only in content, never substitutes metadata for it',()=>{
  const normal=modelToolResult('paper_full_text',{text:'body',data:{characters:4}});
  assert.equal(normal.content[0].text,'body');assert.deepEqual(normal.structuredContent,{characters:4});
  const annotations=modelToolResult('research_annotations',{text:'long comment',count:1});
  assert.equal(annotations.content[0].text,'long comment');assert.deepEqual(annotations.structuredContent,{count:1});
});
