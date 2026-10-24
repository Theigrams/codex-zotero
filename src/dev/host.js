// Test host for the preflight: embeds the panel in an iframe and talks to it through the official
// AppBridge over postMessage, the same path Codex uses. Tool calls are forwarded to the standalone server.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

// Same origin as the panel, so it shares the panel's JS heap; keep its own message logging from
// retaining responses, or test/memory.mjs would measure the test host instead of the panel.
console.debug = () => {};

const frame = document.querySelector('iframe');
const bridge = new AppBridge(null, { name: 'codex-zotero preflight host', version: '0.1.0' }, {
  serverTools: {}, serverResources: {}, message: { text: {}, image: {} },
  updateModelContext: { text: {}, image: {}, structuredContent: {} }, logging: {},
}, { hostContext: { displayMode: 'fullscreen', platform: 'desktop', theme: 'light', locale: 'zh-CN' } });

bridge.oncalltool = async params => {
  const r = await fetch('/api/call', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  if (!r.ok) return { isError: true, content: [{ type: 'text', text: await r.text() }] };
  return { content: [{ type: 'text', text: 'ok' }], structuredContent: await r.json() };
};
bridge.onmessage = async () => ({});
bridge.onupdatemodelcontext = async () => ({});

await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = '/panel';
