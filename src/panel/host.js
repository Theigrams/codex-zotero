// Talks to the server: through the Codex host bridge inside Codex, over HTTP in the browser preflight.
import { App } from '@modelcontextprotocol/ext-apps';

// ext-apps' PostMessageTransport console.debug()s every message it receives. Each strip response carries
// a base64 page image, and a console with an inspector attached keeps every logged object alive:
// ~180MB retained after a few passes over one paper (test/memory.mjs). The panel never uses console.debug.
console.debug = () => {};

export async function connect() {
  if (window.parent !== window) {
    const app = new App({ name: 'codex-zotero', version: '0.1.0' }, {}, { autoResize: false });
    try {
      await app.connect(undefined, { timeout: 10000 });
      return {
        app,
        mode: 'host',
        async call(name, args = {}) {
          const r = await app.callServerTool({ name, arguments: args });
          if (r.isError) throw new Error(r.content?.find(c => c.type === 'text')?.text || `${name} failed`);
          return r.structuredContent;
        },
      };
    } catch {
      // Opened in a frame without a host (e.g. a preview): fall through to HTTP.
    }
  }
  return {
    app: null,
    mode: 'standalone',
    async call(name, args = {}) {
      const r = await fetch('/api/call', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  };
}
