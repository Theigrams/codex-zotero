// Memory probe: does the panel's JS heap stay bounded after reading a whole paper and zooming?
//   node test/memory.mjs --pdf FILE [--passes 3]
// Runs the panel twice: directly over HTTP, and inside the AppBridge test host (postMessage, like Codex).
// Heap is read after a forced GC, so it measures what is really retained, not garbage awaiting collection.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const pdf = arg('--pdf');
const passes = Number(arg('--passes', 3));
const sandbox = await mkdtemp(join(tmpdir(), 'codex-zotero-memory-'));
const env = { ...process.env, CODEX_ZOTERO_STATE: join(sandbox, 'state'), CODEX_ZOTERO_CACHE: join(sandbox, 'cache') };
const server = spawn(process.execPath, ['out/plugin/dist/server.mjs', '--standalone', '--pdf', pdf], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const base = await new Promise(resolve => {
  let err = '';
  server.stderr.on('data', d => { err += d; const m = err.match(/standalone panel: (http:\/\/[^/]+)/); if (m) resolve(m[1]); });
});
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
  defaultViewport: { width: 980, height: 946, deviceScaleFactor: 2 },
});

async function run(path) {
  const page = await browser.newPage();
  await page.goto(base + path);
  const frame = await (async () => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find(f => f.url().endsWith('/panel'));
      if (f && (await f.evaluate(() => window.__reader?.metrics.openSharpMs != null).catch(() => false))) return f;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('panel did not open');
  })();
  const heap = () => frame.evaluate(async () => {
    window.gc?.();
    await new Promise(r => setTimeout(r, 300));
    window.gc?.();
    return Math.round(performance.memory.usedJSHeapSize / 1048576);
  });
  const start = await heap();
  const after = [];
  const seen = []; // what the ⇧D debug line shows: the heap as it is, garbage not yet collected included
  for (let p = 0; p < passes; p++) {
    seen.push(await frame.evaluate(async zoomed => {
      const r = window.__reader, sc = r.scroller;
      const samples = [];
      if (zoomed) r.zoomBy(1.4); else r.fitWidth();
      await new Promise(done => {
        let prev = performance.now();
        requestAnimationFrame(function step(t) {
          sc.scrollTop += (4000 * (t - prev)) / 1000;
          prev = t;
          samples.push(performance.memory.usedJSHeapSize);
          if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2) requestAnimationFrame(step); else done();
        });
      });
      await new Promise(r => setTimeout(r, 1500));
      sc.scrollTop = 0;
      await new Promise(r => setTimeout(r, 1500));
      samples.push(performance.memory.usedJSHeapSize);
      const mb = v => Math.round(v / 1048576);
      return { maxMB: mb(Math.max(...samples)), endMB: mb(samples.at(-1)) };
    }, p % 2 === 1));
    after.push(await heap());
  }
  const images = await frame.evaluate(() => ({ ...window.__reader.imageStats, inDom: document.querySelectorAll('.page img[src]').length }));
  await page.close();
  return { path, startMB: start, afterEachPassMB: after, debugLineMB: seen, images };
}

try {
  for (const path of ['/panel', '/host']) console.log(JSON.stringify(await run(path)));
} finally {
  await browser.close();
  server.kill();
  await rm(sandbox, { recursive: true, force: true });
}
