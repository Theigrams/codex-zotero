// Browser preflight of the built panel (standalone server, system Chrome, DPR 2, isolated state).
//   node test/preflight.mjs --pdf /path/to/paper.pdf [--out DIR] [--headful] [--quick]
// --quick skips the performance measurements (scroll frame rate, sharpness after scroll and zoom).
// Checks the reading core end to end and prints indicative numbers. Not a substitute for the real Codex panel.
import puppeteer from 'puppeteer-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeZotero } from './fake-zotero.mjs';

// The Python install.mjs would use: CODEX_ZOTERO_PYTHON, else python3, if it can import PyMuPDF.
function pythonWithPyMuPDF() {
  try {
    return execFileSync(process.env.CODEX_ZOTERO_PYTHON || 'python3', ['-c', 'import sys, pymupdf; print(sys.executable)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const pdf = arg('--pdf');
if (!pdf) throw new Error('usage: node test/preflight.mjs --pdf FILE');
const outDir = arg('--out') || 'out/preflight';
await mkdir(outDir, { recursive: true });
const sandbox = await mkdtemp(join(tmpdir(), 'codex-zotero-preflight-'));
// The paper is opened as a Zotero item of a fake Zotero, so annotations are exercised without a real library.
const SEED = { key: 'SEEDHL01', annotationType: 'highlight', annotationColor: '#ff7675', annotationText: 'seeded', annotationComment: 'seed',
  annotationPageLabel: '1', annotationSortIndex: '00000|000000|00300', annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[100, 500, 300, 512]] }) };
// A second paper for tabs: the same PDF with a trailing comment, so it gets its own fingerprint.
const second = join(sandbox, 'second.pdf');
await writeFile(second, Buffer.concat([await readFile(pdf), Buffer.from('\n%second copy\n')]));
const QUOTED = encodeURIComponent(JSON.stringify({ attachmentURI: 'http://zotero.org/users/local/x/items/ATTACH01', position: { pageIndex: 2, rects: [[60, 400, 280, 410]] } }));
const NOTE = `<div data-schema-version="9"><h1>预检笔记</h1><p>能量 <span class="math">$E = mc^2$</span></p><pre class="math">$$\\mathbf{T} = \\begin{bmatrix}a & b\\\\ c & d\\end{bmatrix}$$</pre>
${'<p>段落填充，用于测试滚动位置。</p>'.repeat(120)}<h2>引用</h2><p><span class="highlight" data-annotation="${QUOTED}">“quoted from page 3”</span></p><h2>表格</h2><table><tr><th>符号</th><th>含义</th></tr><tr><td>A</td><td>转角</td></tr></table></div>`;
const zotero = await fakeZotero({ pdf, title: 'Preflight paper', annotations: [SEED], notes: [NOTE], papers: [{ key: 'PAPER002', attachment: 'ATTACH02', title: 'Second paper', pdf: second }] });
const env = {
  ...process.env, CODEX_ZOTERO_STATE: join(sandbox, 'state'), CODEX_ZOTERO_CACHE: join(sandbox, 'cache'), CODEX_ZOTERO_API: zotero.url,
  CODEX_ZOTERO_CODEX: new URL('./fake-codex.mjs', import.meta.url).pathname, // paper maps without calling a real model
  CODEX_ZOTERO_PYTHON: pythonWithPyMuPDF(), // as install.mjs finds it
  CODEX_ZOTERO_FAST: '1', // short polls and retry backoff: the checks need not sit through the real waits
};

const server = spawn(process.execPath, ['out/plugin/dist/server.mjs', '--standalone', '--item', 'PAPER001'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const url = await new Promise((resolve, reject) => {
  let err = '';
  server.stderr.on('data', d => {
    err += d;
    const m = err.match(/standalone panel: (\S+)/);
    if (m) resolve(m[1]);
  });
  server.on('exit', c => reject(new Error(`server exited ${c}\n${err}`)));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Polls fn until it returns something truthy (returned) or ms pass (null).
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
};
const QUICK = process.argv.includes('--quick');
const startedAt = Date.now();
const checks = [];
let lastCheck = Date.now();
// Each check records how long it took since the previous one, so slow stretches show in the report.
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail, ms: Date.now() - lastCheck });
  lastCheck = Date.now();
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !process.argv.includes('--headful'),
  args: ['--enable-precise-memory-info'],
  defaultViewport: { width: 1026, height: 946, deviceScaleFactor: 2 },
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => m.type() === 'error' && !m.location()?.url?.includes('favicon') && errors.push(m.text()));
  const metrics = () => page.evaluate(() => {
    const m = window.__reader.metrics;
    const p = (a, q) => (a.length ? Math.round([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.round(q * (a.length - 1)))]) : null);
    const f = m.frames;
    return {
      openSharpMs: m.openSharpMs ?? null,
      fps: f.length ? Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)) : null,
      over20msPct: f.length ? Math.round((1000 * f.filter(x => x > 20).length) / f.length) / 10 : null,
      sharpAfterScroll: { n: m.sharpAfterScroll.length, p50: p(m.sharpAfterScroll, 0.5), p95: p(m.sharpAfterScroll, 0.95) },
      sharpAfterZoom: { n: m.sharpAfterZoom.length, p50: p(m.sharpAfterZoom, 0.5), p95: p(m.sharpAfterZoom, 0.95) },
      memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    };
  });
  const bar = () => page.evaluate(() => ({ page: document.getElementById('pageLabel').textContent, zoom: document.getElementById('zoomLabel').textContent }));

  // 0. The harness must refuse what Codex refuses, or this preflight proves nothing about images.
  await page.goto(url);
  const sandbox = await page.evaluate(async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const load = src => new Promise(done => { const i = new Image(); i.onload = () => done(i.naturalWidth); i.onerror = () => done(0); i.src = src; });
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    return { data: await load(`data:image/png;base64,${png}`), blob: await load(URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))) };
  });
  check('preflight sandbox: data: images allowed, blob: blocked (as in Codex)', sandbox.data === 1 && sandbox.blob === 0, JSON.stringify(sandbox));
  errors.length = 0; // the blocked blob: probe above logs a CSP error on purpose

  // 1. Open: cropped, edge to edge, sharp.
  await page.reload();
  await page.waitForFunction(() => window.__reader?.metrics.openSharpMs != null, { timeout: 20000 });
  const layout = await page.evaluate(() => {
    const r = window.__reader, L = r.layout[0];
    const strip = document.querySelector('.page img:not(.preview)');
    return { cssW: L.w, bitmapW: L.plan.bitmapW, left: r.left, viewport: r.scroller.clientWidth, mode: L.plan.mode,
      stripNatural: strip?.naturalWidth, stripCss: strip?.getBoundingClientRect().width, cropW: r.doc.crops[0][2], pageW: r.doc.pages[0].width };
  });
  check('aligned strip shown 1:1', layout.stripNatural === layout.bitmapW && layout.bitmapW === layout.cssW * 2, JSON.stringify(layout));
  check('page fills the panel width', layout.left === 0 && layout.cssW === layout.viewport, `${layout.cssW} / ${layout.viewport}`);
  check('margins cropped', layout.cropW < layout.pageW, `${layout.cropW.toFixed(1)} of ${layout.pageW}pt`);
  await page.screenshot({ path: `${outDir}/1-open.png` });

  // 2. Scroll: steady, then flicks (measured; --quick only checks that the page label follows).
  if (QUICK) {
    await page.evaluate(() => { window.__reader.scroller.scrollTop += 3000; });
    await sleep(200);
    await page.evaluate(() => { window.__reader.scroller.scrollTop -= 800; }); // scrolling up brings the bar back
    await sleep(300);
  } else await page.evaluate(async () => {
    const sc = window.__reader.scroller;
    const phase = (speed, ms) => new Promise(done => {
      const start = performance.now();
      let prev = start;
      requestAnimationFrame(function step(t) {
        sc.scrollTop += (speed * (t - prev)) / 1000;
        prev = t;
        if (t - start < ms) requestAnimationFrame(step); else done();
      });
    });
    window.__reader.metrics.frames = [];
    await phase(1500, 3000); await new Promise(r => setTimeout(r, 700));
    await phase(6000, 1200); await new Promise(r => setTimeout(r, 700));
    await phase(-6000, 1000); await new Promise(r => setTimeout(r, 900));
  });
  const scroll = await metrics();
  if (!QUICK) {
    check('scroll 60fps', scroll.fps >= 58 && scroll.over20msPct < 2, JSON.stringify(scroll));
    check('sharp after scroll ≤ 150ms (p50)', scroll.sharpAfterScroll.p50 !== null && scroll.sharpAfterScroll.p50 <= 150, JSON.stringify(scroll.sharpAfterScroll));
  }
  check('page label follows', /^\d+ \/ \d+$/.test((await bar()).page), (await bar()).page);

  // 3. Pinch zoom (ctrl+wheel) twice, then keyboard fit width.
  const cdp = await page.createCDPSession();
  for (let round = 0; round < (QUICK ? 1 : 2); round++) {
    for (let i = 0; i < 6; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 500, deltaX: 0, deltaY: -10, modifiers: 2 });
      await sleep(16);
    }
    await sleep(QUICK ? 400 : 1200);
  }
  const zoomed = await metrics();
  if (!QUICK) check('sharp after zoom ≤ 200ms (p50)', zoomed.sharpAfterZoom.n > 0 && zoomed.sharpAfterZoom.p50 <= 200, JSON.stringify(zoomed.sharpAfterZoom));
  check('zoom label updates', (await bar()).zoom !== '100%', (await bar()).zoom);
  await page.screenshot({ path: `${outDir}/2-zoomed.png` });
  await page.keyboard.press('0');
  await until(async () => (await bar()).zoom === '100%', 3000);
  check('0 returns to fit width', (await bar()).zoom === '100%', (await bar()).zoom);

  // 4. Render mode switch through the settings drawer.
  // The toolbar can auto-hide after scrolling; the settings shortcut remains available.
  await page.keyboard.down('Meta');
  await page.keyboard.press(',');
  await page.keyboard.up('Meta');
  await page.waitForSelector('#settings:not([hidden])');
  await page.click('input[value="rounded"]');
  await until(() => page.evaluate(() => {
    const L = window.__reader.layout[0];
    return L.plan.mode === 'rounded' && [...document.querySelectorAll('.page img:not(.preview)')].some(i => i.naturalWidth === L.plan.bitmapW);
  }), 5000);
  const rounded = await page.evaluate(() => {
    const L = window.__reader.layout[0];
    const widths = [...document.querySelectorAll('.page img:not(.preview)')].map(i => i.naturalWidth);
    return { mode: L.plan.mode, bitmapW: L.plan.bitmapW, cssW: L.w, natural: widths.includes(L.plan.bitmapW) ? L.plan.bitmapW : widths[0] };
  });
  check('rounded mode renders the 0.5-step bitmap', rounded.mode === 'rounded' && rounded.natural === rounded.bitmapW && rounded.bitmapW > rounded.cssW * 2, JSON.stringify(rounded));
  await page.screenshot({ path: `${outDir}/3-rounded.png` });
  await page.click('input[value="aligned"]');
  await page.keyboard.press('Escape');
  await sleep(800);

  // 5. Crop toggle.
  await page.keyboard.press('c');
  await until(() => page.evaluate(() => window.__reader.crop === false), 3000);
  const uncropped = await page.evaluate(() => window.__reader.crop);
  await page.keyboard.press('c');
  await until(() => page.evaluate(() => window.__reader.crop === true), 3000);
  check('C toggles the original page', uncropped === false && (await page.evaluate(() => window.__reader.crop)) === true);

  // 6. Jump with G, wait for the position save, reload, expect the same page.
  await page.keyboard.press('g');
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await sleep(1500);
  const before = (await bar()).page;
  await page.reload();
  await page.waitForFunction(() => window.__reader?.metrics.openSharpMs != null, { timeout: 20000 });
  check('reading position restored after reload', (await bar()).page === before && before.startsWith('12'), `${before} → ${(await bar()).page}`);

  // Installation checks accept any PDF; the full suite below uses its documented CAD fixture.
  if (process.argv.includes('--installation')) {
    const repaired = await page.evaluate(async () => (await window.__selection.textFor(1)).repaired);
    check('installed Python text repair works', repaired);
  } else {
  // 7. Selection: double-click a word, drag across lines, ⌥-drag a region, ask, context.
  await page.evaluate(() => window.__reader.scrollToPage(1));
  await sleep(1200);
  const target = await page.evaluate(async () => {
    const sel = window.__selection, r = window.__reader;
    const text = await sel.textFor(1);
    const joined = text.t.join('');
    // Client point of a glyph by index (centre of its box).
    const at = i => {
      const [rx, ry, rw, rh] = r.region(0), el = r.pages.get(1).el.getBoundingClientRect();
      const b = text.b.slice(i * 4, i * 4 + 4);
      return { x: el.left + ((b[0] + b[2] / 2 - rx) / rw) * el.width, y: el.top + ((b[1] + b[3] / 2 - ry) / rh) * el.height };
    };
    const offsetOf = s => { let n = 0; for (let i = 0; i < text.t.length; i++) { if (joined.slice(n).startsWith(s)) return i; n += text.t[i].length; } return -1; };
    const word = offsetOf('Singularity');
    const para = offsetOf('As an inherent');
    return { repaired: text.repaired, hasTitle: joined.includes('Singularity'), word: at(word + 2), paraStart: at(para), paraEnd: at(para + 140) };
  });
  check('page text repaired by MuPDF', target.repaired && target.hasTitle, JSON.stringify({ repaired: target.repaired }));
  await page.mouse.click(target.word.x, target.word.y, { clickCount: 1 });
  await page.mouse.click(target.word.x, target.word.y, { clickCount: 2 });
  await sleep(500);
  const dbl = await page.evaluate(() => ({ text: window.__selection.current?.text, toolbar: !document.getElementById('toolbar').hidden }));
  check('double-click selects a word and shows the toolbar', /Singularity/.test(dbl.text || '') && dbl.toolbar, JSON.stringify(dbl));
  await page.mouse.move(target.paraStart.x - 1, target.paraStart.y);
  await page.mouse.down();
  await page.mouse.move(target.paraEnd.x, target.paraEnd.y, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const dragged = await page.evaluate(() => ({ text: window.__selection.current?.text, lines: window.__selection.current?.rects.length }));
  await page.screenshot({ path: `${outDir}/4-selection.png` });
  check('drag selects across lines', dragged.lines >= 2 && /^As an inherent/.test(dragged.text || ''), JSON.stringify(dragged).slice(0, 160));
  await page.click('#ask');
  await sleep(1500);
  const sent = await page.evaluate(() => window.__sent.slice());
  const attached = await page.evaluate(() => window.__contexts.items);
  check('chat handoff attaches the selection without sending a message', !sent.some(m => m.kind === 'message') && attached.some(b => b.text.includes('As an inherent') && b.image), `${attached.length} attached blocks`);
  const ctx = sent.filter(m => m.kind === 'context').at(-1);
  check('reading context synced with the selection', ctx && ctx.text.includes('选中了第 1 页') && ctx.text.includes('第 1 / '), ctx?.text.slice(0, 120));
  await page.keyboard.down('Alt');
  await page.mouse.move(target.paraStart.x, target.paraStart.y - 40);
  await page.mouse.down();
  await page.mouse.move(target.paraEnd.x + 60, target.paraEnd.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(300);
  const region = await page.evaluate(() => window.__selection.current);
  check('⌥-drag selects a region', region?.kind === 'region' && region.rect[2] > 20 && region.rect[3] > 20, JSON.stringify(region));
  await page.keyboard.press('Escape');
  await sleep(200);
  check('Esc clears the selection', await page.evaluate(() => window.__selection.current === null && document.getElementById('toolbar').hidden));

  // 7b. Annotations: drawn where Zotero has them, created with H / ⇧3, edited in the popup, listed in the drawer.
  const stored = () => zotero.annotations().filter(a => !a.data.deleted);
  await page.evaluate(() => window.__reader.scrollToPage(1));
  await sleep(800);
  const seeded = await until(() => page.evaluate(() => {
    const el = document.querySelector('.page[data-page="1"] .ann.hl');
    if (!el) return null;
    const pg = el.closest('.page').getBoundingClientRect(), r = el.getBoundingClientRect();
    const [rx, ry, rw, rh] = window.__reader.region(0), H = window.__reader.doc.pages[0].height;
    return { top: (r.top - pg.top) / pg.height, expectTop: (H - 512 - ry) / rh, left: (r.left - pg.left) / pg.width, expectLeft: (100 - rx) / rw };
  }));
  check('Zotero annotation drawn at its place', seeded && Math.abs(seeded.top - seeded.expectTop) < 0.002 && Math.abs(seeded.left - seeded.expectLeft) < 0.002, JSON.stringify(seeded));

  await page.mouse.click(target.word.x, target.word.y, { clickCount: 1 });
  await page.mouse.click(target.word.x, target.word.y, { clickCount: 2 });
  await sleep(400);
  const drawnIn = await page.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById('scroller').dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true }));
    await new Promise(r => requestAnimationFrame(r));
    return { ms: Math.round(performance.now() - t0), n: document.querySelectorAll('.page[data-page="1"] .ann.hl').length, cleared: window.__selection.current === null };
  });
  check('H draws the highlight at once and clears the selection', drawnIn.n === 2 && drawnIn.cleared && drawnIn.ms < 100, JSON.stringify(drawnIn));
  // Text under a highlight must stay black: the tint multiplies onto the page instead of veiling it.
  await sleep(300);
  const hlBox = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.page[data-page="1"] .ann.hl')].at(-1).getBoundingClientRect();
    return { x: r.left + 1, y: r.top + 1, width: r.width - 2, height: r.height - 2 };
  });
  const shot = await page.screenshot({ clip: hlBox, encoding: 'base64', captureBeyondViewport: false }); // a resize would re-lay the reader out
  const ink = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      min = Math.min(min, l);
      max = Math.max(max, l);
    }
    return { darkest: Math.round(min), lightest: Math.round(max) };
  }, shot);
  check('text under a highlight stays black (tint multiplies, no veil)', ink.darkest < 45 && ink.lightest > 150, JSON.stringify(ink));
  const created = await until(() => stored().find(a => a.key !== 'SEEDHL01'));
  check('highlight written to Zotero with color, tag and text', created && /Singularity/.test(created.data.annotationText) && created.data.annotationColor === '#ffd400'
    && created.data.tags.some(t => t.tag === '重点') && zotero.state.authorizations === 1, created ? JSON.stringify({ text: created.data.annotationText, tags: created.data.tags, auth: zotero.state.authorizations }) : 'not written');

  await page.mouse.move(target.paraStart.x - 1, target.paraStart.y);
  await page.mouse.down();
  await page.mouse.move(target.paraEnd.x, target.paraEnd.y, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Digit3');
  await page.keyboard.up('Shift');
  const under = await until(() => stored().find(a => a.data.annotationType === 'underline'));
  check('⇧3 underlines in blue with the 定义 tag', under && under.data.annotationColor === '#2ea8e5' && under.data.tags.some(t => t.tag === '定义') && /^As an inherent/.test(under.data.annotationText),
    under ? `${under.data.annotationText.slice(0, 40)}…` : 'not written');

  await page.mouse.click(target.word.x, target.word.y);
  await sleep(200);
  const opened = await page.evaluate(() => !document.getElementById('annPopup').hidden && document.getElementById('annMeta').textContent);
  check('click on a highlight opens its popup', opened && opened.includes('重点'), String(opened));
  await page.keyboard.press('2');
  const recolored = await until(() => stored().find(a => a.key === created?.key && a.data.annotationColor === '#a28ae5'));
  check('2 in the popup recolors to purple and swaps the tag', recolored && recolored.data.tags.map(t => t.tag).join() === '问答', recolored ? JSON.stringify(recolored.data.tags) : 'not written');
  await page.click('#annComment');
  await page.keyboard.type('**测试**评论 $\\sin x^2$');
  const livePreview = await page.evaluate(() => document.querySelectorAll('#annCommentView.preview .katex').length);
  await page.keyboard.press('Escape');
  const commented = await until(() => stored().find(a => a.key === created?.key && a.data.annotationComment === '**测试**评论 $\\sin x^2$'));
  check('comment saved when the popup closes', commented && (await page.$eval('#annPopup', el => el.hidden)), commented?.data.annotationComment);
  await page.mouse.click(target.word.x, target.word.y);
  await sleep(200);
  const shownMath = await page.evaluate(() => ({ math: document.querySelectorAll('#annCommentView:not([hidden]) .katex').length, bold: document.querySelector('#annCommentView strong')?.textContent, editor: !document.getElementById('annComment').hidden }));
  check('comments show Markdown and formulas rendered, with a live preview while editing', livePreview === 1 && shownMath.math === 1 && shownMath.bold === '测试' && !shownMath.editor, JSON.stringify({ livePreview, ...shownMath }));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${outDir}/5-annotations.png` });

  await page.evaluate(() => window.__reader.scrollToPage(5));
  await sleep(500);
  await page.keyboard.press('a');
  await sleep(300);
  const listed = await page.$$eval('#drawerList li', lis => lis.map(li => li.textContent));
  check('drawer lists the annotations in reading order', listed.length === 3 && listed[0].startsWith('seeded') && listed[1].startsWith('Singularity'), JSON.stringify(listed).slice(0, 200));
  const tagFilter = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll('#drawerFilter button')].map(b => b.textContent);
    document.querySelector('#drawerFilter button[data-tag="定义"]')?.click();
    await new Promise(r => setTimeout(r, 50));
    const shown = [...document.querySelectorAll('#drawerList li')].map(li => li.textContent);
    document.querySelector('#drawerFilter button:not([data-tag])').click();
    return { buttons, shown };
  });
  check('tag chips in the drawer show their color', await page.evaluate(() => {
    const b = document.querySelector('#drawerFilter button[data-tag="定义"]');
    return b?.classList.contains('dot') && b.style.getPropertyValue('--c') === '#2ea8e5';
  }));
  check('drawer filters by tag only (no color filter)', tagFilter.buttons.includes('定义 1') && tagFilter.buttons.includes('问答 1') && tagFilter.shown.length === 1 && tagFilter.shown[0].startsWith('As an inherent')
    && !(await page.$('#drawerFilter button[data-color]')), JSON.stringify(tagFilter).slice(0, 160));
  check('a list inside a comment keeps ordinary list styling in the drawer', await page.evaluate(() => {
    const c = document.querySelector('#drawerList .c');
    c.insertAdjacentHTML('beforeend', '<ul><li>x</li></ul>');
    const nested = c.querySelector('ul li');
    const ok = getComputedStyle(nested).display === 'list-item';
    nested.parentElement.remove();
    return ok;
  }));
  check('drawer shows comment Markdown and formulas rendered', await page.evaluate(() => document.querySelectorAll('#drawerList .c .katex').length === 1 && document.querySelector('#drawerList .c strong')?.textContent === '测试'));
  await page.click(`#drawerList li[data-key="${under?.key}"]`);
  await sleep(500);
  const jumped = await page.evaluate(() => ({ page: window.__reader.currentPage(), active: document.querySelectorAll('.ann.active').length }));
  check('clicking a drawer entry jumps to it', jumped.page <= 2 && jumped.active > 0, JSON.stringify(jumped));
  await page.screenshot({ path: `${outDir}/6-drawer.png` });

  zotero.edit('SEEDHL01', { annotationComment: '改自 Zotero' });
  const remote = await until(() => page.evaluate(() => document.getElementById('drawerList').textContent.includes('改自 Zotero')), 8000);
  check('edits made in Zotero show up by themselves', remote);

  zotero.revoke();
  zotero.state.auth = 'deny';
  await page.keyboard.press('Escape');
  await page.mouse.click(target.paraEnd.x, target.paraEnd.y, { clickCount: 1 });
  await page.mouse.click(target.paraEnd.x, target.paraEnd.y, { clickCount: 2 });
  await sleep(300);
  await page.keyboard.press('4');
  await page.keyboard.press('a');
  const failed = await until(() => page.evaluate(() => document.getElementById('drawerWrites').textContent));
  check('a refused write shows only in the drawer, with retry', failed && failed.includes('未写入') && failed.includes('重试'), String(failed).slice(0, 120));
  zotero.state.auth = 'always';
  await page.click('#drawerWrites button');
  const retried = await until(() => stored().find(a => a.data.annotationColor === '#5fb236'));
  const writesLeft = await until(() => page.evaluate(() => document.getElementById('drawerWrites').textContent === ''));
  check('retry writes it', retried && writesLeft);

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__reader.scrollToPage(1));
  await sleep(500);
  await page.mouse.click(target.word.x, target.word.y);
  await sleep(200);
  await page.click('#annDelete');
  const erased = await until(() => !zotero.annotations().some(a => a.key === created?.key));
  check('delete removes it from Zotero, as Zotero itself does', erased && (await page.evaluate(k => !window.__annotations.find(k), created?.key)));
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  const undone = await until(() => stored().find(a => a.key !== created?.key && /Singularity/.test(a.data.annotationText || '') && a.data.annotationComment === '**测试**评论 $\\sin x^2$'));
  check('⌘Z brings the deleted annotation back', undone && (await until(() => page.evaluate(k => !!window.__annotations.find(k), undone.key))), undone?.key);

  // Triple click selects the whole sentence.
  await page.mouse.click(target.paraStart.x + 30, target.paraStart.y, { clickCount: 1 });
  await page.mouse.click(target.paraStart.x + 30, target.paraStart.y, { clickCount: 2 });
  await page.mouse.click(target.paraStart.x + 30, target.paraStart.y, { clickCount: 3 });
  await sleep(400);
  const sentence = await page.evaluate(() => window.__selection.current?.text || '');
  check('triple click selects the sentence', /^As an inherent flaw/.test(sentence) && /feedrate\.$/.test(sentence), sentence.slice(0, 50) + ' … ' + sentence.slice(-30));
  await page.keyboard.press('Escape');

  // 9. Find, the model's tools, home and tabs.
  const model = (name, args = {}) => page.evaluate(async (name, args) => (await fetch('/api/model', { method: 'POST', body: JSON.stringify({ name, arguments: args }) })).json(), name, args);
  await page.keyboard.press('Escape');
  await page.keyboard.down('Meta');
  await page.keyboard.press('f');
  await page.keyboard.up('Meta');
  await page.keyboard.type('singularity');
  const found = await until(() => page.evaluate(() => /^\d+ \/ \d+$/.test(document.getElementById('findCount').textContent) && document.getElementById('findCount').textContent));
  const firstHit = await page.evaluate(() => window.__find.cur);
  await page.keyboard.press('Enter');
  await sleep(300);
  const stepped = await page.evaluate(() => ({ cur: window.__find.cur, marked: document.querySelectorAll('.hit.cur').length }));
  check('⌘F finds every occurrence and steps with return', found && Number(found.split(' / ')[1]) > 10 && stepped.cur === firstHit + 1 && stepped.marked > 0, `${found} ${JSON.stringify(stepped)}`);
  await page.keyboard.press('Escape');
  check('Esc closes find and clears the marks', await page.evaluate(() => document.getElementById('findBar').hidden && !document.querySelector('.hit')));

  await page.evaluate(() => window.__reader.scrollToPage(3));
  await sleep(1200);
  const st = await model('reader_state');
  check('reader_state knows the paper and page', /Preflight paper/.test(st.text) && /当前第 3 页/.test(st.text), st.text?.slice(0, 120) || st.error);
  check('preparing context is not recorded as a sent question', !/上次用面板提问/.test(st.text || ''));
  const pc = await model('paper_context');
  check('paper_context returns nearby pages and annotations', /=== 第 2 页/.test(pc.text) && /=== 第 4 页/.test(pc.text) && /批注/.test(pc.text), `${pc.text?.length} chars`);
  check('paper_context includes the paper\'s structure', /结构/.test(pc.text) && /Introduction（第 1 页）/.test(pc.text), (pc.text?.match(/结构[^\n]*\n[^\n]*\n[^\n]*/) || ['none'])[0]);
  const sa = await model('search_annotations', { query: '改自' });
  check('search_annotations finds annotations across the library with their paper', /《Preflight paper》/.test(sa.text) && /SEEDHL01/.test(sa.text), sa.text?.slice(0, 80) || sa.error);
  const fp = await model('find_in_paper', { query: 'tool orientation' });
  check('find_in_paper lists pages with snippets', /第 \d+ 页：/.test(fp.text), fp.text?.split('\n')[0]);
  const quote = 'singularity can induce dramatic changes in machine axes motion';
  const qa1 = await model('annotate', { quote, page: 1, question: '为什么会剧烈变化？', answer: '奇异点附近逆运动学解急剧变化（第 1 页）。' });
  const qaItem = await until(() => stored().find(a => a.data.tags.some(t => t.tag === 'AI问答')));
  check('annotate saves a located Q&A as a purple AI问答 highlight', qaItem && qaItem.data.annotationColor === '#a28ae5' && qaItem.data.annotationComment.startsWith('问：为什么会剧烈变化？\n答：')
    && qaItem.data.annotationText.includes('dramatic changes'), qa1.text || qa1.error);
  const qa2 = await model('annotate', { quote, page: 1, question: '这会影响什么？', answer: '进给速度波动（第 1 页）。' });
  const merged = await until(() => stored().find(a => a.key === qaItem?.key && a.data.annotationComment.includes('这会影响什么')));
  check('a second answer at the same place joins the same annotation', merged && stored().filter(a => a.data.tags.some(t => t.tag === 'AI问答')).length === 1, qa2.text || qa2.error);
  const mark = await until(() => page.evaluate(() => document.querySelectorAll('.page[data-page="1"] .ann.mark').length), 5000);
  check('AI answers get a margin mark in the panel', mark === 1);
  const long = await model('annotate', { quote, page: 1, question: '展开讲讲', answer: '很长的解释。'.repeat(60) });
  check('annotate refuses a long answer: comments keep only the core', /太长/.test(long.error || ''), long.error?.slice(0, 40));
  const bad = await model('annotate', { quote: 'this sentence is not in the paper anywhere' });
  check('annotate refuses a quote it cannot find', /找不到/.test(bad.error || ''), bad.error);
  const show = await model('show_location', { quote: 'admissible tool orientation annulus', page: 1 });
  const shown = await until(() => page.evaluate(() => document.querySelectorAll('.flash').length > 0 && window.__reader.currentPage()), 4000);
  check('show_location scrolls the panel there and outlines it', shown === 1, `${show.text || show.error} → page ${shown}`);

  await page.evaluate(() => window.__reader.scrollToPage(1));
  await sleep(1000);
  const link = await page.evaluate(async () => {
    const r = window.__reader;
    const { links } = await (await fetch('/api/call', { method: 'POST', body: JSON.stringify({ name: 'page_links', arguments: { docId: r.doc.id, page: 1 } }) })).json();
    const l = links.find(x => x.page > 1 && x.point?.[1] != null);
    if (!l) return null;
    const [rx, ry, rw, rh] = r.region(0), el = r.pages.get(1).el.getBoundingClientRect();
    return { target: l.page, x: el.left + ((l.rect[0] + l.rect[2] / 2 - rx) / rw) * el.width, y: el.top + ((l.rect[1] + l.rect[3] / 2 - ry) / rh) * el.height };
  });
  if (link) {
    await page.mouse.move(link.x - 30, link.y);
    await page.mouse.move(link.x, link.y, { steps: 3 });
    const previewed = await until(() => page.evaluate(() => !document.getElementById('linkPreview').hidden && document.querySelector('#linkPreview img').naturalWidth), 4000);
    await page.screenshot({ path: `${outDir}/8-link-preview.png` });
    check('resting on a link previews its target, cropped to the target column', previewed > 100 && previewed < 800, `→ page ${link.target}, ${previewed}px wide`);
    await page.mouse.click(link.x, link.y);
    const landed = await until(() => page.evaluate(t => window.__reader.currentPage() === t || window.__reader.position().page === t, link.target), 3000);
    check('clicking a link jumps to its target', landed, `target page ${link.target}`);
    const alt = async key => {
      await page.keyboard.down('Alt');
      await page.keyboard.press(key);
      await page.keyboard.up('Alt');
      await sleep(300);
    };
    await alt('ArrowLeft');
    check('⌥← returns to where the link was', await page.evaluate(() => window.__reader.position().page === 1 && document.getElementById('back').hidden));
    await alt('ArrowRight');
    const forward = await page.evaluate(() => window.__reader.position().page);
    await alt('ArrowLeft');
    check('⌥→ goes forward to the link target again', forward === link.target && (await page.evaluate(() => window.__reader.position().page)) === 1, `forward → ${forward}`);
  } else {
    check('paper has internal links to test', false, 'no internal link on page 1');
  }

  await page.keyboard.press('a');
  const noteRow = await until(() => page.evaluate(() => document.querySelector('#drawerNotes li')?.textContent));
  check('the drawer lists the paper\'s Zotero notes', noteRow === '预检笔记', String(noteRow));
  await page.click('#drawerNotes li');
  const noteShown = await until(() => page.evaluate(() => !document.getElementById('noteView').hidden && {
    math: document.querySelectorAll('#noteView .katex').length, block: document.querySelectorAll('#noteView .katex-display').length,
    table: document.querySelectorAll('#noteView td').length, tab: document.querySelector('.tab.on')?.textContent }));
  const onNote = await until(async () => { const r = await model('reader_state'); return /笔记《预检笔记》/.test(r.text || '') && r; }, 4000);
  const ctxOnNote = await model('paper_context');
  check('with a note on screen, reader_state reports the note and paper tools still use the paper', onNote && /Preflight paper/.test(ctxOnNote.text || ''), (onNote?.text || '').slice(0, 60) + ' / ' + (ctxOnNote.text || ctxOnNote.error || '').slice(0, 40));
  await page.screenshot({ path: `${outDir}/10-note.png` });
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const k = document.querySelector('#noteView .katex .mord');
    // With the installed fonts KaTeX's metrics hold; without them a fraction or integral collapses.
    return { katex: k && getComputedStyle(k).fontFamily, lora: getComputedStyle(document.getElementById('noteView')).fontFamily.split(',')[0] };
  });
  check('notes use KaTeX for formulas and Lora for Latin text', /KaTeX_/.test(fonts.katex || '') && /Lora/.test(fonts.lora), JSON.stringify(fonts));
  check('a note opens in its own tab with formulas and tables', noteShown && noteShown.math === 2 && noteShown.block === 1 && noteShown.table === 2 && noteShown.tab.includes('笔记：预检笔记'), JSON.stringify(noteShown));
  await page.screenshot({ path: `${outDir}/9-note.png` });
  await page.evaluate(() => { document.getElementById('noteView').scrollTop = 1500; });
  await sleep(700);
  await page.evaluate(() => document.querySelector('.tab:not(.on)').click());
  await until(() => page.evaluate(() => document.getElementById('noteView').hidden));
  await page.evaluate(() => [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('笔记')).click());
  const noteTop = await until(() => page.evaluate(() => !document.getElementById('noteView').hidden && document.getElementById('noteView').scrollTop));
  check('a note tab keeps its scroll position', Math.abs(noteTop - 1500) < 30, String(noteTop));
  await page.keyboard.press('a');
  const toc = await page.$$eval('#tocList li', lis => lis.map(li => li.textContent));
  check('A shows the note\'s table of contents', toc.join('|') === '预检笔记|引用|表格', toc.join('|'));
  await page.keyboard.press('Escape');
  await page.click('#noteView .highlight');
  const backToPaper = await until(() => page.evaluate(() => window.__reader.doc && document.getElementById('noteView').hidden && document.querySelectorAll('.flash').length && window.__reader.currentPage()), 5000);
  check('clicking a quoted highlight in the note opens the paper there', backToPaper === 3, String(backToPaper));
  const rn = await model('read_notes');
  const rn2 = await model('read_notes', { key: 'NOTE0001', section: '表格' });
  check('read_notes lists notes and returns a section as text', /NOTE0001/.test(rn.text) && /## 引用/.test(rn.text) && /^## 表格/.test(rn2.text) && /\| A \| 转角/.test(rn2.text), `${rn.text?.slice(0, 60)} / ${rn2.text || rn2.error}`);

  // Paper map: only on request; written as a Zotero note; read once with paper_map.
  const noMap = await model('paper_map');
  check('without a map, paper_map says so and nothing is generated by itself', /还没有论文地图/.test(noMap.text || '') && ![...zotero.state.items.values()].some(i => i.data.itemType === 'note' && i.data.tags?.some(t => t.tag === '论文地图')), noMap.text?.slice(0, 40));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { if (document.getElementById('annDrawer').hidden) document.getElementById('annButton').click(); });
  await until(() => page.evaluate(() => !!document.querySelector('#drawerNotes button[data-map]')));
  await page.click('#drawerNotes button[data-map]');
  const mapNote = await until(() => [...zotero.state.items.values()].find(i => i.data.itemType === 'note' && i.data.tags?.some(t => t.tag === '论文地图')), 8000);
  check('the drawer button generates the map and saves it as a Zotero note with math and a table', mapNote && /<span class="math">/.test(mapNote.data.note) && /<table>/.test(mapNote.data.note) && /状态：未核验/.test(mapNote.data.note),
    mapNote ? mapNote.data.note.slice(0, 80) : 'no note');
  const listedMap = await until(() => page.evaluate(() => document.querySelector('#drawerNotes li')?.textContent.startsWith('论文地图') && !document.querySelector('#drawerNotes .mapRow')), 6000);
  check('the drawer lists the map first and, once it exists, offers nothing more', listedMap);
  const readMap = await model('paper_map');
  const ctxMap = await model('paper_context');
  check('paper_map returns the map; paper_context only points to it', /## 一句话/.test(readMap.text || '') && /本篇有论文地图/.test(ctxMap.text || '') && !/## 一句话/.test(ctxMap.text || ''), (readMap.text || readMap.error || '').slice(0, 40));
  await model('paper_map_generate');
  await until(async () => (await model('paper_map')).data?.exists && !(await page.evaluate(() => document.querySelector('#drawerNotes .mapRow')?.textContent.includes('生成中'))), 8000);
  const maps = [...zotero.state.items.values()].filter(i => i.data.itemType === 'note' && i.data.tags?.some(t => t.tag === '论文地图'));
  check('regenerating replaces the same note', maps.length === 1 && maps[0].key === mapNote?.key, `${maps.length} map notes`);
  const linkCount = (maps[0]?.data.note.match(/href="zotero:\/\/open-pdf\/library\/items\/ATTACH01\?page=/g) || []).length;
  check('map page and equation/figure references are zotero://open-pdf links', linkCount >= 5 && /k=eq/.test(maps[0].data.note) && /k=fig/.test(maps[0].data.note), `${linkCount} links`);
  await page.evaluate(() => [...document.querySelectorAll('#drawerNotes li')].find(li => li.textContent.startsWith('论文地图')).click());
  await until(() => page.evaluate(() => !document.getElementById('noteView').hidden && !!document.querySelector('#noteView a[href*="k=eq"]')));
  await page.evaluate(() => document.querySelector('#noteView a[href*="k=eq"]').click());
  const landed = await until(() => page.evaluate(() => document.getElementById('noteView').hidden && document.querySelector('.page[data-page="8"] .flash') && document.getElementById('back').textContent), 5000);
  check('clicking 式 (11) in the map opens the paper at the equation, outlined', landed === '↩ 回到笔记', String(landed));
  const eqLink = maps[0].data.note.match(/page=(\d+)&amp;y=(\d+)&amp;x=(\d+)&amp;k=eq/);
  const oldStyle = eqLink && await page.evaluate(async ([pg, y]) => (await (await fetch('/api/call', { method: 'POST', body: JSON.stringify({ name: 'note_jump', arguments: { attachmentKey: 'ATTACH01', page: pg, y, kind: 'eq' } }) })).json()).target, [Number(eqLink[1]), Number(eqLink[2])]);
  check('a map link made before links carried x still finds the equation\'s column', oldStyle && oldStyle.x === Number(eqLink[3]), JSON.stringify(oldStyle));
  const flashW = await page.evaluate(() => parseFloat(document.querySelector('.page[data-page="8"] .flash')?.style.width));
  check('the equation outline is narrower than the page (its column, not the full width)', flashW > 5 && flashW < 95, `${flashW}%`);
  await page.evaluate(() => document.getElementById('back').click());
  const backToMap = await until(() => page.evaluate(() => !document.getElementById('noteView').hidden && document.querySelector('.tab.on')?.textContent.startsWith('笔记：论文地图')), 5000);
  check('↩ returns to the map', backToMap);
  await page.evaluate(() => document.querySelector('.tab.on i').click()); // close the map tab; later steps count tabs
  await until(() => page.evaluate(() => document.querySelectorAll('.tab').length === 2));

  // Guided reading: the reading questions, and the reading note updated question by question.
  const readingNotes = () => [...zotero.state.items.values()].filter(i => i.data.itemType === 'note' && i.data.tags?.some(t => t.tag === '精读笔记'));
  const guide = await model('reading_guide');
  check('reading_guide gives the reading questions in full; there is no reading note yet', /第 4 问 【重要】作者的思考路径：不以本文的贡献为前提/.test(guide.text || '') && /还没有精读笔记/.test(guide.text || '') && !readingNotes().length,
    (guide.text || guide.error || '').slice(0, 60));
  const saved1 = await model('reading_note_save', { sections: [{ title: '问题从哪里来', content: '五轴加工中的奇异问题 [p.1]。' }, { title: '作者的想法', content: '见式 (11) [p.8]。' }], done: [1, 4] });
  const readNote1 = await until(() => readingNotes()[0]);
  check('reading_note_save writes the reading note: its sections, page links, progress', readNote1 && /<h1>精读笔记：Preflight paper<\/h1>/.test(readNote1.data.note) && /<h2>问题从哪里来<\/h2>/.test(readNote1.data.note)
    && /items\/ATTACH01\?page=8/.test(readNote1.data.note) && /已读完：第 1 问 研究问题与价值；第 4 问/.test(readNote1.data.note) && /未读到：第 2、3、5、6、7、8、9 问/.test(saved1.text || ''), saved1.text || saved1.error);
  await model('reading_note_save', { sections: [{ title: '实验说明了什么', content: '检测更快 [p.11]。' }], done: [8] });
  const readNote2 = await until(() => readingNotes().length === 1 && /实验说明了什么/.test(readingNotes()[0].data.note) && readingNotes()[0]);
  check('the next question goes into the same note; earlier sections and progress stay', readNote2 && readNote2.key === readNote1?.key && /五轴加工中的奇异问题/.test(readNote2.data.note) && /已读完：第 1 问[^<]*第 4 问[^<]*第 8 问/.test(readNote2.data.note), `${readingNotes().length} notes`);
  const guide2 = await model('reading_guide');
  const ctxReading = await model('paper_context');
  check('reading_guide marks what is done; paper_context points to the reading note', /第 8 问 实验如何验证主张（已读完）/.test(guide2.text || '') && /本篇有精读笔记/.test(ctxReading.text || '') && /已读完 3 个精读问题/.test(ctxReading.text || ''));

  // Settings: the palette, shortcuts and the map prompt are the user's.
  const prefsNow = () => page.evaluate(async () => (await (await fetch('/api/call', { method: 'POST', body: JSON.stringify({ name: 'prefs_set', arguments: {} }) })).json()).prefs);
  await page.keyboard.down('Meta');
  await page.keyboard.press('Comma');
  await page.keyboard.up('Meta');
  const rows = await until(() => page.evaluate(() => !document.getElementById('settings').hidden && document.querySelectorAll('#paletteList li').length));
  check('⌘, opens the settings with the five default colors', rows === 5, String(rows));
  await page.evaluate(() => {
    const input = document.querySelector('#paletteList li input[type=text]');
    input.value = '要点';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(async () => (await prefsNow()).palette[0].tag === '要点');
  await page.click('#paletteAdd');
  await until(async () => (await prefsNow()).palette.length === 6);
  await page.evaluate(() => document.querySelectorAll('#paletteList li .sw')[5].click());
  await page.screenshot({ path: `${outDir}/9-settings.png` });
  const swatches = await page.evaluate(() => [...document.querySelectorAll('#swatches button')].map(b => b.disabled));
  await page.evaluate(() => document.querySelector('#swatches button:not([disabled])[data-color="#aaaaaa"]')?.click());
  const custom = await until(async () => { const p = await prefsNow(); return p.palette[5]?.color === '#aaaaaa' && p.palette; });
  check('the palette can be renamed, extended and recolored (colors in use are not offered twice)', custom && custom[0].tag === '要点' && swatches.filter(d => !d).length === 3,
    JSON.stringify(custom)?.slice(0, 120));
  await page.evaluate(() => document.querySelectorAll('#paletteList li .del')[5].click());
  await until(async () => (await prefsNow()).palette.length === 5);
  await page.click('#keyList button[data-action="back"]');
  await page.keyboard.down('Meta');
  await page.keyboard.press('BracketLeft');
  await page.keyboard.up('Meta');
  const rebound = await until(async () => (await prefsNow()).keys.back === 'Meta+[');
  const keyShown = await page.$eval('#keyList button[data-action="back"]', b => b.textContent);
  await page.click('#keyList button[data-action="back"]');
  await page.keyboard.press('Digit2');
  const refused = await page.$eval('#keysNote', el => el.textContent);
  check('a shortcut is rebound by pressing it; fixed keys are refused', rebound && keyShown === '⌘[' && /固定/.test(refused), `${keyShown} / ${refused}`);
  await page.click('#keysReset');
  const prompt = await page.$eval('#mapPrompt', el => el.value);
  await page.evaluate(() => {
    const t = document.getElementById('mapPrompt');
    t.value = '只写三段，每段一句。';
    t.dispatchEvent(new Event('change'));
  });
  const savedPrompt = await until(async () => (await prefsNow()).mapPrompt === '只写三段，每段一句。');
  check('the map prompt is shown and can be replaced', /一句话/.test(prompt) && savedPrompt, prompt.slice(0, 30));
  const tplShown = await page.$eval('#noteTemplate', el => el.value);
  await page.evaluate(() => {
    const t = document.getElementById('noteTemplate');
    t.value = '### 没有分组的问题';
    t.dispatchEvent(new Event('change'));
  });
  const tplRefused = await until(() => page.evaluate(() => document.getElementById('noteNote').textContent.includes('分组') && document.getElementById('noteTemplate').value === '### 没有分组的问题'));
  check('the reading questions are shown in full; broken ones are refused and kept for correction', /### 关键人物与实验室/.test(tplShown) && tplRefused && !(await prefsNow()).readingQuestions);
  await page.click('#mapReset');
  await page.click('#noteReset');
  await page.click('#paletteReset');
  const reset = await until(async () => { const p = await prefsNow(); return !p.mapPrompt && !p.readingQuestions && p.palette[0].tag === '重点' && !Object.keys(p.keys).length; });
  check('each section resets to its default', reset);
  await page.keyboard.press('Escape');

  await page.evaluate(() => document.getElementById('newTab').click()); // the bar may have slid away while reading
  await sleep(500);
  const recent = await page.$$eval('#homeList li b', els => els.map(e => e.textContent));
  const homeContext = await until(() => page.evaluate(() => window.__sent.filter(m => m.kind === 'context').at(-1)?.text.includes('首页')));
  check('the conversation context says the panel is on the home page', homeContext);
  const onHome = await until(async () => /首页/.test((await model('reader_state')).text || ''), 4000);
  check('reader_state says the panel is on the home page', onHome);
  check('home lists the papers being read', recent.includes('Preflight paper'), JSON.stringify(recent));
  await page.type('#search', 'second');
  await until(() => page.evaluate(() => document.getElementById('homeHeading').textContent === 'Zotero' && document.querySelectorAll('#homeList li').length === 1));
  await page.keyboard.press('Enter');
  const opened2 = await until(() => page.evaluate(() => window.__reader.doc?.title === 'Second paper' && window.__reader.metrics && document.querySelectorAll('.tab').length));
  check('searching Zotero and pressing return opens the paper in a new tab', opened2 === 3, String(opened2));
  await page.keyboard.down('Meta');
  await page.keyboard.press('Digit1');
  await page.keyboard.up('Meta');
  const back = await until(() => page.evaluate(() => window.__reader.doc?.title === 'Preflight paper' && document.querySelector('.tab.on')?.textContent.includes('Preflight')));
  check('⌘1 switches back to the first tab', back);
  await page.reload();
  const restored = await until(() => page.evaluate(() => window.__reader?.doc && { tabs: document.querySelectorAll('.tab').length, title: window.__reader.doc.title }), 15000);
  check('tabs are restored after reopening the panel', restored?.tabs === 3 && restored.title === 'Preflight paper', JSON.stringify(restored));
  await page.evaluate(() => document.querySelector('.tab:not(.on) i').click());
  await until(() => page.evaluate(() => document.querySelectorAll('.tab').length === 2));
  await page.evaluate(() => document.querySelector('.tab:not(.on) i').click());
  const closed = await until(() => page.evaluate(() => document.querySelectorAll('.tab').length === 1 && window.__reader.doc?.title === 'Preflight paper'));
  check('closing a background tab keeps the current paper', closed);
  await page.screenshot({ path: `${outDir}/7-tabs.png` });

  // 8. A newer panel supersedes this one.
  const second = await browser.newPage();
  await second.goto(url);
  await second.waitForFunction(() => window.__reader?.metrics.openSharpMs != null, { timeout: 20000 });
  const superseded = await until(() => page.$eval('#messageText', el => el.textContent.includes('新的面板') && el.textContent), 6000) || await page.$eval('#messageText', el => el.textContent);
  check('older panel steps aside', superseded.includes('新的面板'), superseded);

  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  const report = { checks, scroll, zoomed, layout, rounded };
  await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 1));
} catch (e) {
  check('preflight ran to the end', false, e.stack || e.message);
} finally {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${String(((c.ms ?? 0) / 1000).toFixed(1)).padStart(5)}s ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  console.log(`total ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  process.exitCode = checks.every(c => c.ok) ? 0 : 1;
  await browser.close();
  server.kill();
  await zotero.close();
  await rm(sandbox, { recursive: true, force: true });
}
