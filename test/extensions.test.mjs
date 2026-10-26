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
import { exportContextMarkdown } from '../src/shared/context-export.mjs';

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

function testConversation(overrides = {}) {
  globalThis.window = {};
  const host = { app: { getHostCapabilities: () => ({ message: { text: {} } }), ...overrides.app }, call: async () => ({}), ...overrides };
  const reader = { doc: { id:'a'.repeat(16), title:'Paper', pageCount:1 }, currentPage:()=>1, range:()=>[1,1] };
  const conversation = new Conversation({ host, reader, selection: { current:null } });
  return { conversation, host };
}

test('page registration never claims Chat model access or injects the cached body', () => {
  const { conversation } = testConversation();
  try {
    conversation.setFullTextStatus(conversation.reader.doc.id, { complete:true, version:'v1', characters:29451, body:'PRIVATE FULL BODY' });
    for (const registered of [[], ['reader_read_full_text','reader_read_pages']]) {
      conversation.readingTools = registered;
      const { text, structured } = conversation.context();
      assert.deepEqual(structured.readingAccess, { registeredPageTools:registered, modelToolExposure:'unknown' });
      assert.equal(structured.liveReadingTools, undefined);
      assert.match(text, /工具名出现在上下文中，不代表工具可调用/);
      assert.match(text, /不要尝试连接浏览器/);
      assert.doesNotMatch(text, /PRIVATE FULL BODY|可使用这些页面内工具/);
      assert.doesNotMatch(JSON.stringify(structured), /PRIVATE FULL BODY/);
    }
  } finally { clearTimeout(conversation.timer); delete globalThis.window; }
});

test('private connector session follows paper and research-home context without claiming discovery', () => {
  const {conversation}=testConversation();
  try {
    conversation.readerSession='b'.repeat(32);
    for(const elsewhere of [null,'文库首页']) {
      conversation.elsewhere=elsewhere;
      const result=conversation.context();
      assert.equal(result.structured.readingAccess.readerSession,'b'.repeat(32));
      assert.equal(result.structured.readingAccess.modelToolExposure,'unknown');
      assert.ok(result.text.includes('readerSession='+ 'b'.repeat(32)));
    }
  } finally {delete globalThis.window;}
});

test('preparing a question publishes context without changing fullscreen or the native draft', async () => {
  const events = [];
  const { conversation } = testConversation({ app: {
    getHostCapabilities:()=>({}), getHostContext:()=>({displayMode:'fullscreen',availableDisplayModes:['inline','fullscreen']}),
    updateModelContext:async()=>{events.push('context');},
    requestDisplayMode:async()=>assert.fail('must keep fullscreen'),
    sendMessage:async()=>assert.fail('must not send or edit a draft'),
  }});
  conversation.contextBlocks = { items:[], add:async()=>{events.push('attach');return true;} };
  assert.equal(await conversation.continueInChat({addSelection:true}),true);
  assert.deepEqual(events,['attach','context']);
  assert.equal(conversation.handingOff,false);
  delete globalThis.window;
});

test('failed attachment does not prepare an incomplete question', async () => {
  const { conversation } = testConversation({app:{getHostCapabilities:()=>({}),updateModelContext:async()=>assert.fail('attachment was not prepared')}});
  conversation.contextBlocks={items:[],add:async()=>undefined};
  assert.equal(await conversation.continueInChat({addSelection:true}),undefined);
  assert.equal(conversation.handingOff,false);
  delete globalThis.window;
});

test('failed context sync is surfaced and preparing the question can be retried', async () => {
  const { conversation,host }=testConversation({app:{getHostCapabilities:()=>({}),updateModelContext:async()=>{throw new Error('sync failed');},requestDisplayMode:async()=>assert.fail('context was not published')}});
  await assert.rejects(()=>conversation.continueInChat(),/sync failed/);
  assert.equal(conversation.handingOff,false);
  host.app.updateModelContext=async()=>({});host.app.getHostContext=()=>({displayMode:'inline'});
  assert.equal(await conversation.continueInChat(),true);
  delete globalThis.window;
});

test('unsupported new drafts never fall back to sending; draft guard resets after errors', async () => {
  const {conversation,host}=testConversation();
  await assert.rejects(()=>conversation.draftNewConversation(),/不支持/);
  host.extensions={message:{send:async()=>{throw new Error('transport failed');}}};
  await assert.rejects(()=>conversation.draftNewConversation(),/transport failed/);
  assert.equal(conversation.sending,false);
  let message;
  host.extensions.message.send=async p=>{message=p;return {};};
  await conversation.draftNewConversation();
  assert.deepEqual(message._meta['openai/message'],{target:'new',send:false});
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

test('context export keeps selected text and source locations without thumbnails or hidden full text', () => {
  const text=exportContextMarkdown([{id:'block',contextNumber:3,title:'Paper <title>',docId:'a'.repeat(16),page:2,type:'formula',rect:[1,2,3,4],text:'E = mc²\n<script>no</script>',source:'ocr',image:'SECRET_IMAGE'}]);
  assert.match(text,/上下文 3/);assert.match(text,/第 2 页/);assert.match(text,/MinerU OCR/);
  assert.match(text,/> E = mc²/);assert.match(text,/&lt;script&gt;/);assert.doesNotMatch(text,/SECRET_IMAGE|<script>/);
  const link=text.match(/\[返回原文位置\]\(([^)]+)\)/)[1];
  assert.deepEqual(parseReaderRoute(new URL(link).searchParams.get('path')),{docId:'a'.repeat(16),page:2,rect:[1,2,3,4]});
});
