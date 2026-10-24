// Builds the plugin into out/: native helper, bundled MCP server, self-contained panel, Codex manifests.
//   node build.mjs
// out/ contains this machine's install path and stays out of Git.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

export const MARKET = 'codex-zotero-local';
export const PLUGIN = 'codex-zotero';
export const VERSION = JSON.parse(await readFile('package.json', 'utf8')).version;
export const INSTALLED = join(homedir(), '.codex', 'plugins', 'cache', MARKET, PLUGIN, VERSION);
// Codex ships its own Node; the server runs on it.
const NODE = process.env.CODEX_ZOTERO_NODE || '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';

// KaTeX's stylesheet for formulas in notes and comments. Its fonts are not bundled: the panel's sandbox blocks
// font files (default-src 'none'), so install.mjs installs KaTeX's fonts and Lora for the user, and the panel
// uses them by name — the @font-face rules are dropped.
async function katexCSS() {
  const css = (await readFile('node_modules/katex/dist/katex.min.css', 'utf8')).replace(/@font-face\{[^}]*\}/g, '');
  if (/url\(fonts\//.test(css)) throw new Error('KaTeX CSS still points at font files');
  return css;
}

// python: absolute path of a Python with PyMuPDF (install.mjs finds it), or '' for none.
export async function buildPlugin({ python = process.env.CODEX_ZOTERO_PYTHON || '' } = {}) {
  const root = 'out/plugin';
  await rm('out', { recursive: true, force: true });
  await mkdir(`${root}/dist`, { recursive: true });
  await mkdir(`${root}/.codex-plugin`, { recursive: true });
  await mkdir('out/.agents/plugins', { recursive: true });

  execFileSync('swiftc', ['-O', 'native/PDFKitHelper.swift', '-o', `${root}/dist/pdfkit-helper`], { stdio: 'inherit' });
  for (const f of ['text_server.py', 'text_layer.py']) await writeFile(`${root}/dist/${f}`, await readFile(`native/${f}`));
  await cp('skills', `${root}/skills`, { recursive: true });

  await build({
    entryPoints: ['src/server/index.mjs'], outfile: `${root}/dist/server.mjs`, bundle: true, platform: 'node',
    format: 'esm', target: 'node22', logLevel: 'warning',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });

  const ui = await build({
    entryPoints: ['src/panel/main.js'], bundle: true, write: false, platform: 'browser', format: 'iife',
    target: 'chrome120', minify: true, logLevel: 'warning',
  });
  let html = await readFile('src/panel/index.html', 'utf8');
  const katex = await katexCSS();
  html = html.replace('/* BUNDLED_KATEX */', () => katex);
  html = html.replace('/* BUNDLED_APP */', () => ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
  new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); // syntax check of the inlined bundle
  await writeFile(`${root}/dist/panel.html`, html);

  // Preflight-only test host (AppBridge over postMessage, like Codex); served by --standalone at /host.
  const host = await build({ entryPoints: ['src/dev/host.js'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'chrome120', minify: true, logLevel: 'warning' });
  await writeFile(`${root}/dist/host.html`, '<!doctype html><meta charset="utf-8"><title>preflight host</title>'
    + '<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>'
    + `<iframe></iframe><script type="module">${host.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);

  const ui_ = {
    displayName: 'Zotero 阅读器',
    shortDescription: '在 Codex 中阅读 Zotero 论文',
    longDescription: 'Read Zotero PDFs in the Codex panel with Apple PDFKit rendering.',
    developerName: 'Local',
    category: 'Productivity',
    capabilities: ['Interactive', 'Read'],
    defaultPrompt: ['打开 Zotero 阅读器。', '打开那篇关于奇异点规避的论文。'],
  };
  await writeFile(`${root}/.codex-plugin/plugin.json`, JSON.stringify({
    name: PLUGIN, version: VERSION, description: ui_.longDescription, author: { name: 'Local' }, license: 'MIT',
    requires_local_executor: true, interface: ui_, skills: './skills/', mcpServers: './.mcp.json',
  }, null, 2));
  // Codex starts the server without this shell's environment: CODEX_ZOTERO_* settings in effect now (docs/CONFIG.md)
  // go into the launch config, with the Python that was found.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CODEX_ZOTERO_') && k !== 'CODEX_ZOTERO_NODE'));
  if (python) env.CODEX_ZOTERO_PYTHON = python;
  else delete env.CODEX_ZOTERO_PYTHON;
  await writeFile(`${root}/.mcp.json`, JSON.stringify({
    mcpServers: { [PLUGIN]: { command: NODE, args: [join(INSTALLED, 'dist', 'server.mjs')], ...(Object.keys(env).length ? { env } : {}) } },
  }, null, 2));
  await writeFile('out/.agents/plugins/marketplace.json', JSON.stringify({
    name: MARKET, interface: { displayName: 'Codex Zotero' },
    plugins: [{ name: PLUGIN, source: { source: 'local', path: './plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildPlugin();
  console.log(`built out/ (install target ${INSTALLED})`);
}
