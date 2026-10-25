import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerExtensions } from '../src/server/extensions.mjs';
import { State } from '../src/server/state.mjs';
import { readerDeepLink, readerRoute, parseReaderRoute } from '../src/shared/reader-links.mjs';
import { z } from 'zod';
import { Conversation } from '../src/panel/conversation.js';
import { ContextBlocks } from '../src/panel/contexts.js';

test('reader links round-trip locations and reject unrelated or malformed routes', () => {
  const location = { itemKey: 'PAPER001', page: 2, rect: [10,20,30,40] };
  assert.deepEqual(parseReaderRoute(readerRoute(location)), location);
  assert.equal(new URL(readerDeepLink(location)).searchParams.get('path'), readerRoute(location));
  for (const path of ['//outside/paper/PAPER001', 'https://example.com', '/paper/PAPER001?page=-1', '/paper/PAPER001?rect=1,2,NaN,4', '/paper/PAPER001#fragment', '/paper/no-such-id']) assert.equal(parseReaderRoute(path), null);
});

test('old context acknowledgement does not remove new local blocks; user removal still applies', () => {
  const contexts=Object.create(ContextBlocks.prototype);
  contexts.items=[{id:'a'},{id:'b'}];contexts.changed=()=>{};
  contexts.pendingHostStates=[{updateId:'our-1',content:[{type:'text',_meta:{'zotero/blockId':'a'}}]}];
  contexts.endPublish('our-1');
  assert.deepEqual(contexts.items.map(x=>x.id),['a','b']);
  contexts.applyHostState({updateId:'user-2',content:[{type:'text',_meta:{'zotero/blockId':'b'}}]});
  assert.deepEqual(contexts.items.map(x=>x.id),['b']);
});

test('native paper chooser accepts only a returned candidate and preserves cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zotero-forms-'));
  const server = new McpServer({ name:'forms', version:'1' });
  registerExtensions(server, { state:new State(root), prefsChanged:()=>{}, searchLibrary:async()=>[{ key:'PAPER001', title:'Paper' }] });
  const client = new Client({ name:'forms', version:'1' }, { capabilities:{ extensions:{ 'openai/elicitation':{form:{}} } } });
  let answer = { action:'accept', content:{itemKey:'PAPER001'} };
  client.setRequestHandler(z.object({method:z.literal('openai/elicitation/create'),params:z.unknown()}), async()=>answer);
  const [a,b]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    let result=await client.callTool({name:'reader_choose',arguments:{query:'Paper'}});
    assert.equal(JSON.parse(result.content[0].text).key,'PAPER001');
    answer={action:'cancel'};
    result=await client.callTool({name:'reader_choose',arguments:{query:'Paper'}});
    assert.equal(JSON.parse(result.content[0].text).cancelled,true);
    answer={action:'accept',content:{itemKey:'OTHER001'}};
    result=await client.callTool({name:'reader_choose',arguments:{query:'Paper'}});
    assert.equal(result.isError,true);
  } finally { await client.close();await server.close();await rm(root,{recursive:true,force:true}); }
});

test('unsupported drafts never fall back to sending; sending guard resets after errors', async () => {
  globalThis.window = {};
  let sends=0;
  const app={getHostCapabilities:()=>({message:{text:{}}}),sendMessage:async()=>{sends++;return {};},updateModelContext:async()=>({})};
  const host={app,call:async()=>({})};
  const reader={doc:{id:'a'.repeat(16),title:'Paper',pageCount:1},currentPage:()=>1,range:()=>[1,1]};
  const conversation=new Conversation({host,reader,selection:{current:null}});
  await assert.rejects(()=>conversation.ask('test',{send:false}),/不支持/);
  assert.equal(sends,0);
  app.sendMessage=async()=>{throw new Error('transport failed');};
  await assert.rejects(()=>conversation.ask('test'),/transport failed/);
  assert.equal(conversation.sending,false);
  delete globalThis.window;
});

test('official settings and mentions helpers interoperate with MCP SDK 1, persist settings and resolve metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zotero-extensions-'));
  const server = new McpServer({ name: 'test', version: '1' });
  const state = new State(root); let changes = 0;
  registerExtensions(server, { state, prefsChanged: () => changes++, searchLibrary: async () => [{ key: 'PAPER001', title: 'Paper' }],
    readItem: async () => ({ data: { title: 'Paper', date: '2026' } }) });
  const client = new Client({ name: 'test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.equal(client.getServerCapabilities().experimental['openai/settings'].readTool, 'reader_settings_read');
    assert.equal(client.getServerCapabilities().experimental['openai/mentions'].searchTool, 'search_mentions');
    const settings = await client.callTool({ name: 'reader_settings_read', arguments: {} });
    assert.deepEqual(Object.keys(settings.structuredContent.values).sort(), ['allowModelOcr','layoutEnabled','renderMode']);
    assert.ok(!JSON.stringify(settings).includes('apiKey'));
    const update = await client.callTool({ name: 'reader_settings_update', arguments: { set: { layoutEnabled: false } } });
    assert.equal(update.structuredContent.values.layoutEnabled, false);
    assert.equal(update.structuredContent.values.allowModelOcr, true);
    assert.equal((await state.prefs()).layoutEnabled, false); assert.equal(changes, 1);
    const bad = await client.callTool({ name: 'reader_settings_update', arguments: { set: { unknown: true } } });
    assert.equal(bad.isError, true);
    const mentions = await client.callTool({ name: 'search_mentions', arguments: { query: 'paper' } });
    assert.equal(mentions.structuredContent.items[0].uri, 'zotero://paper/PAPER001');
    const resource = await client.readResource({ uri: 'zotero://paper/PAPER001' });
    assert.equal(JSON.parse(resource.contents[0].text).itemKey, 'PAPER001');
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.find(t => t.name === 'search_mentions')._meta.ui.visibility, ['app']);
  } finally { await client.close(); await server.close(); await rm(root, { recursive:true, force:true }); }
});
