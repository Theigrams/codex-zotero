import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OpenAIFormSchema } from '@openai/mcp-extensions';
import { z } from 'zod';
import { registerExtensions } from '../src/server/extensions.mjs';
import { State } from '../src/server/state.mjs';

test('native research picker supplies thumbnails, multi-select previews and goal suggestions, validates choices and cancellation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-form-'));
  const server=new McpServer({name:'test',version:'1'});
  const research={candidates:async()=>[1,2].map(i=>({itemKey:`PAPER00${i}`,title:`Paper ${i}`,uri:`zotero://paper/PAPER00${i}`})),
    preview:async()=>({image:'data:image/png;base64,aW1n'}),status:async keys=>({papers:keys.map(itemKey=>({itemKey,title:itemKey}))})};
  registerExtensions(server,{state:new State(root),searchLibrary:async()=>[],prefsChanged:()=>{},research});
  const client=new Client({name:'test',version:'1'},{capabilities:{extensions:{'openai/elicitation':{form:{}}}}});
  let answer={action:'accept',content:{papers:['zotero://paper/PAPER001','zotero://paper/PAPER002'],objective:'自定义研究目标',includeAnnotations:true}},schema;
  client.setRequestHandler(z.object({method:z.literal('openai/elicitation/create'),params:z.unknown()}),async req=>{schema=req.params.requestedSchema;return answer;});
  const[a,b]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(a),client.connect(b)]);
    let result=await client.callTool({name:'research_choose',arguments:{query:'paper'}});
    assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.structuredContent.papers.length,2);assert.equal(result.structuredContent.objective,'自定义研究目标');
    OpenAIFormSchema.parse(schema);
    const input=schema.properties.papers['x-openai-input'];assert.equal(input.selection,'explicit');
    assert.match(input.options[0]._meta['openai/thumbnail'].src,/^data:image/);assert.equal(input.options[0]._meta['openai/preview'].target.name,'research_preview');
    assert.equal(schema.properties.objective['x-openai-suggestions'].length,3);
    answer={action:'cancel'};result=await client.callTool({name:'research_choose',arguments:{query:'paper'}});assert.equal(result.structuredContent.cancelled,true);
    answer={action:'accept',content:{papers:['file:///private.pdf'],objective:'bad',includeAnnotations:true}};result=await client.callTool({name:'research_choose',arguments:{query:'paper'}});assert.equal(result.isError,true);
  }finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});
