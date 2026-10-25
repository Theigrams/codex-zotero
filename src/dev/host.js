// Test host for the preflight: embeds the panel in an iframe and talks to it through the official
// AppBridge over postMessage, the same path Codex uses. Tool calls are forwarded to the standalone server.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { z } from 'zod';

// Same origin as the panel, so it shares the panel's JS heap; keep its own message logging from
// retaining responses, or test/memory.mjs would measure the test host instead of the panel.
console.debug = () => {};

const frame = document.querySelector('iframe');
let currentHostContext = { displayMode: 'fullscreen', platform: 'desktop', theme: 'light', locale: 'zh-CN' };
const bridge = new AppBridge(null, { name: 'codex-zotero preflight host', version: '0.1.0' }, {
  serverTools: {}, serverResources: {}, message: { text: {}, image: {} },
  experimental: { 'openai/modelContext': {}, 'openai/message': {}, 'openai/files': {}, 'openai/resource': {} },
  updateModelContext: { text: {}, image: {}, structuredContent: {} }, logging: {},
}, { hostContext: currentHostContext });

window.__callOverrides = {};
window.__toolCalls = [];
bridge.oncalltool = async params => {
  window.__toolCalls.push(params.name);
  if (window.__callOverrides[params.name]) return { content: [], structuredContent: window.__callOverrides[params.name] };
  const r = await fetch('/api/call', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  if (!r.ok) return { isError: true, content: [{ type: 'text', text: await r.text() }] };
  return { content: [{ type: 'text', text: 'ok' }], structuredContent: await r.json() };
};
window.__messages = [];
bridge.onmessage = async (params, extra) => { window.__messages.push({ ...params, _meta: extra._meta }); return {}; };
window.__openedFiles = [];
bridge.setRequestHandler(z.object({ method: z.literal('openai/files/open'), params: z.object({ path: z.string() }) }), async ({ params }) => {
  window.__openedFiles.push(params.path); return {};
});
window.__setHostContext = context => { currentHostContext = { ...currentHostContext, ...context }; bridge.setHostContext(currentHostContext); };
window.__activate = data => bridge.sendToolResult({ content: [], structuredContent: data });
window.__subscriptions = [];
for (const method of ['resources/subscribe', 'resources/unsubscribe']) bridge.setRequestHandler(z.object({method:z.literal(method),params:z.object({uri:z.string()})}),async({params})=>{window.__subscriptions.push({method,...params});return {};});
window.__resourceUpdated = uri => bridge.notification({method:'notifications/resources/updated',params:{uri}});
window.__modelContexts = [];
bridge.onupdatemodelcontext = async params => {
  const updateId = `context-${window.__modelContexts.length + 1}`;
  window.__modelContexts.push(params);
  window.__setHostContext({ 'openai/modelContext': { updateId, ...params } });
  return { _meta: { 'openai/modelContext': { updateId } } };
};
window.__clearModelContext = () => bridge.sendHostContextChange({ 'openai/modelContext': null });

await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = '/panel';
