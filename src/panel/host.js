// Talks to the server: through the Codex host bridge inside Codex, over HTTP in the browser preflight.
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

function applyAppearance(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    const n = context?.safeAreaInsets?.[edge];
    if (Number.isFinite(n)) document.documentElement.style.setProperty(`--safe-${edge}`, `${Math.max(0, n)}px`);
  }
}

// ext-apps' PostMessageTransport console.debug()s every message it receives. Each strip response carries
// a base64 page image, and a console with an inspector attached keeps every logged object alive:
// ~180MB retained after a few passes over one paper (test/memory.mjs). The panel never uses console.debug.
console.debug = () => {};

export async function connect({ displayModes = ['fullscreen'] } = {}) {
  if (window.parent !== window) {
    const app = new App({ name: 'codex-zotero', version: '0.1.0' }, { availableDisplayModes: displayModes }, { autoResize: false });
    const extensions = new OpenAIExtensions(app);
    const results = new Set();
    const callTool = async (name,args={}) => {
      const r=await app.callServerTool({name,arguments:args});
      if(r.isError)throw new Error(r.content?.find(c=>c.type==='text')?.text || `${name} failed`);
      return r;
    };
    const host = { callTool, app, extensions, mode: 'host', initialResult: null,
      onResult(fn) { results.add(fn); return () => results.delete(fn); },
      async call(name, args = {}) { return (await callTool(name,args)).structuredContent; },
    };
    // Register before connect: the host may deliver the entrypoint immediately.
    app.ontoolresult = result => { host.initialResult = result; for (const fn of results) fn(result); };
    app.addEventListener('hostcontextchanged', () => applyAppearance(app.getHostContext()));
    try {
      await app.connect(undefined, { timeout: 10000 });
      applyAppearance(app.getHostContext());
      return host;
    } catch {
      // Opened in a frame without a host (e.g. a preview): fall through to HTTP.
    }
  }
  return {
    app: null,
    mode: 'standalone',
    async callTool(name,args={}) {
      const r=await fetch('/api/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});
      if(!r.ok)throw new Error(await r.text());
      const result=await r.json();if(result.isError)throw new Error(result.content?.[0]?.text||'读取失败');return result;
    },
    async call(name, args = {}) {
      const r = await fetch('/api/call', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  };
}
