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
  const remote=window.__ZOTERO_REMOTE__===true;
  if(remote)displayModes=['inline','fullscreen'];
  if (window.parent !== window) {
    const app = new App({ name: 'codex-zotero', version: '0.1.0' }, { availableDisplayModes: displayModes }, { autoResize: false });
    const extensions = new OpenAIExtensions(app);
    const results = new Set();
    let readerSession=null;const sessionWaiters=new Set();
    const bindSession=value=>{if(typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)&&!readerSession){readerSession=value;for(const resolve of sessionWaiters)resolve(value);sessionWaiters.clear();}};
    const getSession=()=>readerSession?Promise.resolve(readerSession):new Promise((resolve,reject)=>{
      const finish=value=>{clearTimeout(timer);sessionWaiters.delete(finish);resolve(value);};
      const timer=setTimeout(()=>{sessionWaiters.delete(finish);reject(new Error('未收到阅读器连接标识，请重新打开阅读器。'));},10000);
      sessionWaiters.add(finish);
    });
    const callTool = async (name,args={}) => {
      const scoped=remote?{...args,readerSession:await getSession()}:args;
      const r=await app.callServerTool({name,arguments:scoped});
      if(r.isError)throw new Error(r.content?.find(c=>c.type==='text')?.text || `${name} failed`);
      return r;
    };
    const host = { callTool, app, extensions, remote, mode: 'host', initialResult: null,
      onResult(fn) { results.add(fn); return () => results.delete(fn); },
      async call(name, args = {}) { return (await callTool(name,args)).structuredContent; },
    };
    // Register before connect: the host may deliver the entrypoint immediately.
    app.ontoolinput = input => bindSession(input.arguments?.readerSession);
    app.ontoolresult = result => {bindSession(result.structuredContent?.readerSession);host.initialResult = result; for (const fn of results) fn(result); };
    let lastSizeMode;
    const appearance = () => {
      const context=app.getHostContext();applyAppearance(context);
      // An inline web reader needs useful space even when the host declines fullscreen.
      if(remote && context?.displayMode==='inline' && lastSizeMode!=='inline')app.sendSizeChanged({height:600}).catch(()=>{});
      lastSizeMode=context?.displayMode;
    };
    app.addEventListener('hostcontextchanged', appearance);
    try {
      await app.connect(undefined, { timeout: 10000 });
      appearance();
      if(remote && app.getHostContext()?.displayMode!=='fullscreen' && app.getHostContext()?.availableDisplayModes?.includes('fullscreen'))app.requestDisplayMode({mode:'fullscreen'}).catch(()=>{});
      return host;
    } catch(error) {
      if(remote)throw error;
      // Opened in a frame without a host (e.g. a preview): fall through to HTTP.
    }
  }
  if(remote)throw new Error('请通过 ChatGPT 的「打开阅读器」工具显示此界面。');
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
