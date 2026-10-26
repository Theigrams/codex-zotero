// Panel shell: tabs, home, drawers, selection toolbar, keyboard, panel lifecycle.
// The reading surface is reader.js; selections are selection.js; what goes to Codex is conversation.js;
// Zotero annotations are annotations.js (layer), popup.js (one annotation) and drawer.js (the list);
// find.js is ⌘F and home.js the search + "being read" page.
import { Blocks } from './blocks.js';
import { ContextBlocks } from './contexts.js';
import { OcrPanel } from './ocr.js';
import { DEFAULT_PALETTE } from '../shared/annotations.mjs';
import { actionFor, comboOf, keymap } from '../shared/keys.mjs';
import { targetBlock } from '../shared/text.mjs';
import { AnnotationLayer } from './annotations.js';
import { Conversation } from './conversation.js';
import { AnnotationDrawer } from './drawer.js';
import { AnnotationPopup } from './popup.js';
import { Find } from './find.js';
import { Home } from './home.js';
import { Links } from './links.js';
import { connect } from './host.js';
import { Reader } from './reader.js';
import { Selection } from './selection.js';
import { Settings } from './settings.js';
import { timing, remoteTiming } from './timing.js';
import { ResearchPanel } from './research.js';
import { Interactions } from './interactions.js';

const $ = id => document.getElementById(id);
const BAR = 28;
const instance = Math.random().toString(36).slice(2, 10);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

let host = null;
let reader = null;
let selection = null;
let conversation = null;
let annotations = null;
let popup = null;
let drawer = null;
let find = null;
let home = null;
let links = null;
let settings = null;
let blocks = null;
let contexts = null;
let ocr = null;
let doc = null;
let noteReturn = null; // { id, title } of the note a link led here from (↩ goes back to it)
let noteTab = null; // the Zotero note shown in the active tab, when it is a note tab
let tabs = [];
let navSeen = 0;
let prefsSeen = 0;
let interactions = null;
let researchPanel = null;
let prefs = { renderMode: 'aligned' };
let keys = keymap();
const palette = () => prefs.palette?.length ? prefs.palette : DEFAULT_PALETTE;

// ---------- states ----------

function showMessage(text, retry = false) {
  $('message').hidden = false;
  $('messageText').textContent = text;
  $('retry').hidden = !retry;
}

function hideMessage() {
  $('message').hidden = true;
}

// ---------- top bar ----------

function updateBar(page = reader?.currentPage()) {
  for (const id of ['pageLabel', 'zoomLabel']) $(id).hidden = !doc || home.isOpen;
  $('layoutButton').hidden = !doc || home.isOpen;
  $('ocrButton').hidden = !doc || home.isOpen;
  $('layoutButton').setAttribute('aria-pressed', String(prefs.layoutEnabled !== false));
  $('annButton').hidden = !(doc || noteTab) || home.isOpen;
  $('annButton').title = noteTab ? '目录（A）' : '批注（A）';
  const back = links?.backPage;
  $('back').hidden = !doc || home.isOpen || (!back && !noteReturn);
  if (back) $('back').textContent = `↩ 第 ${back} 页`;
  else if (noteReturn) $('back').textContent = '↩ 回到笔记';
  if (!doc) return;
  $('pageLabel').textContent = `${page} / ${doc.pageCount}`;
  $('zoomLabel').textContent = `${Math.round((reader?.zoom ?? 1) * 100)}%`;
}

// Hide the bar while reading down, bring it back when scrolling up or near the top.
function bindBar() {
  let lastTop = 0;
  $('scroller').addEventListener('scroll', () => {
    const top = $('scroller').scrollTop;
    const hide = top > lastTop && top > BAR * 2;
    $('bar').classList.toggle('hidden', hide && !$('pageInput').matches(':focus'));
    lastTop = top;
  }, { passive: true });
}

function openPageInput() {
  if (!doc) return;
  const input = $('pageInput');
  $('bar').classList.remove('hidden');
  $('pageLabel').hidden = true;
  input.hidden = false;
  input.max = doc.pageCount;
  input.value = reader.currentPage();
  input.focus();
  input.select();
}

function closePageInput(go) {
  const input = $('pageInput');
  if (input.hidden) return;
  const page = Math.round(Number(input.value));
  input.hidden = true;
  $('pageLabel').hidden = false;
  if (go && page >= 1 && page <= doc.pageCount) reader.scrollToPage(page);
  $('scroller').focus({ preventScroll: true });
}

// ---------- tabs and home ----------

const activeId = () => doc?.id ?? noteTab?.id ?? null;

function renderTabs(active = activeId()) {
  const box = $('tabs');
  box.textContent = '';
  for (const t of tabs) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.id = t.id;
    b.title = t.title;
    b.setAttribute('role', 'tab');
    b.classList.toggle('on', t.id === active && !home.isOpen);
    const name = document.createElement('span');
    name.textContent = t.kind === 'note' ? `笔记：${t.title}` : t.title;
    const x = document.createElement('i');
    x.textContent = '×';
    x.title = '关闭（⌘W）';
    b.append(name, x);
    box.appendChild(b);
  }
  const plus = document.createElement('button');
  plus.id = 'newTab';
  plus.title = '打开论文';
  plus.textContent = '+';
  box.appendChild(plus);
}

// Keeps where the current paper was before something else takes the reader.
function savePosition() {
  if (doc && reader.doc) host.call('position_save', { docId: doc.id, ...reader.position() }).catch(() => {});
}

function showTab(active) {
  if (active.note) showNote(active.note);
  else showDoc(active);
}

// Leaves the paper on screen (if any) so a note, home or another paper can take the panel.
function leavePaper() {
  blocks?.reset(); ocr?.reset();
  savePosition();
  annotations.stop();
  popup.close();
  find.reset();
  drawer.close();
  selection.clear();
  reader.destroy();
  doc = null;
}

const noteContext = n => `[Zotero 阅读器] 用户在看 Zotero 笔记《${n.title}》（笔记 key ${n.key}），没有在看论文原文；可用 read_notes 读取这篇笔记。`;

function showNote(n) {
  noteReturn = null;
  if (doc) leavePaper();
  if (noteTab) saveNotePosition();
  home.hide();
  hideMessage();
  closeToc();
  noteTab = n;
  conversation.showing(noteContext(n), { key: n.key, title: n.title });
  $('noteView').innerHTML = n.html; // sanitized on the server (notes.mjs)
  $('noteView').hidden = false;
  $('noteView').scrollTop = n.position * $('noteView').scrollHeight;
  $('note').hidden = true;
  renderTabs();
  updateBar();
  $('bar').classList.remove('hidden');
  $('noteView').focus({ preventScroll: true });
}

// Remembers how far a note was read, as a fraction of its height (survives width changes).
function saveNotePosition() {
  const v = $('noteView');
  if (noteTab && v.scrollHeight) {
    noteTab.position = v.scrollTop / v.scrollHeight;
    host.call('note_position_save', { key: noteTab.key, top: noteTab.position }).catch(() => {});
  }
}

function hideNote() {
  saveNotePosition();
  noteTab = null;
  closeToc();
  $('noteView').hidden = true;
  $('noteView').textContent = '';
}

function openToc() {
  const list = $('tocList');
  list.textContent = '';
  for (const t of noteTab.toc) {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    li.dataset.level = t.level;
    li.textContent = t.text;
    list.appendChild(li);
  }
  if (!noteTab.toc.length) list.textContent = '这篇笔记没有标题。';
  closeSettings();
  $('tocDrawer').hidden = false;
}

function closeToc() {
  $('tocDrawer').hidden = true;
}

// Clicking a highlight quoted in a note opens its paper at that place.
// zotero://open-pdf/library/items/KEY?page=N[&y=…&k=eq|fig|tab|alg] — the links maps carry (map.mjs).
function pdfLinkTarget(href) {
  const m = href.match(/^zotero:\/\/open-pdf\/library\/items\/([A-Z0-9]{8})\?(.*)$/);
  if (!m) return null;
  const q = new URLSearchParams(m[2]);
  const page = Number(q.get('page'));
  if (!Number.isInteger(page) || page < 1) return null;
  const num = name => (q.get(name) !== null && Number.isFinite(Number(q.get(name))) ? Number(q.get(name)) : undefined);
  const kind = ['eq', 'fig', 'tab', 'alg'].includes(q.get('k')) ? q.get('k') : undefined;
  const [x, y] = [num('x'), num('y')];
  return { attachmentKey: m[1], page, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(kind ? { kind } : {}) };
}

// Clicking a quoted highlight or a page / equation / figure link in a note opens the paper at that place;
// ↩ in the bar (or the back key, ⌥← by default) comes back to the note.
async function onNoteClick(e) {
  const a = e.target.closest('a[href]');
  const link = a && pdfLinkTarget(a.getAttribute('href'));
  if (a && !link) {
    e.preventDefault();
    return links.openUrl(a.href);
  }
  if (link) e.preventDefault();
  const quoted = !link && e.target.closest('.highlight[data-annotation]');
  if (!link && !quoted) return;
  const from = noteTab && { id: noteTab.id, title: noteTab.title };
  try {
    const r = await host.call('note_jump', link || { ref: quoted.dataset.annotation });
    tabs = r.tabs;
    showDoc(r.active);
    noteReturn = from;
    goTo(r.target);
    updateBar();
  } catch (err) {
    showMessage(err.message, true);
  }
}

// Where a note link points: highlight rects, a position found in the structure index, or just a page.
// A figure's caption is under the figure, so it is placed low; table and algorithm captions are on top.
function goTo(t) {
  const [rx, , rw] = reader.region(t.page - 1);
  if (t.rects?.length) {
    reader.scrollToPoint(t.page, Math.min(...t.rects.map(x => x[1])));
    flashRects(t.page, t.rects);
  } else if (t.y != null) {
    reader.scrollToPoint(t.page, t.y, { fig: 0.75, tab: 0.15, alg: 0.15 }[t.kind] ?? 1 / 3);
    flashBlock(t.page, t, [rx, t.y - 3, rw, 14]);
  } else {
    reader.scrollToPage(t.page);
  }
}

// Back: to where a link inside the paper was clicked, else to the note the paper was opened from.
function goBack() {
  if (links.goBack()) return;
  if (noteReturn) {
    const id = noteReturn.id;
    noteReturn = null;
    openTab({ docId: id });
  }
}

function showDoc(active) {
  blocks?.reset(); ocr?.reset();
  noteReturn = null; // a note link sets it again right after
  hideNote();
  home.hide();
  conversation.elsewhere = null;
  hideMessage();
  popup.close();
  find.reset();
  drawer.close();
  selection.clear();
  doc = active.document;
  $('note').hidden = !doc.unsupported;
  reader.load(doc, { mode: prefs.renderMode, position: active.position });
  links.reset();
  annotations.load(doc);
  selection.prefetch(range(...reader.range(0)));
  links.prefetch(range(...reader.range(0)));
  blocks?.prefetch(range(...reader.range(0)));
  ocr?.refresh();
  conversation.schedule();
  renderTabs();
  updateBar();
  $('bar').classList.remove('hidden');
  $('scroller').focus({ preventScroll: true });
}

function showHome() {
  ocr?.close();
  savePosition();
  popup.close();
  find.reset();
  drawer.close();
  closeSettings();
  closeToc();
  selection.clear();
  hideMessage();
  home.show();
  conversation.showing('[Zotero 阅读器] 面板在首页（搜索与在读列表），没有打开论文。');
  $('bar').classList.remove('hidden');
  renderTabs();
  updateBar();
}

function leaveHome() {
  if (!doc && !noteTab) return;
  home.hide();
  conversation.showing(noteTab ? noteContext(noteTab) : null, noteTab ? { key: noteTab.key, title: noteTab.title } : null);
  renderTabs();
  updateBar();
  $('scroller').focus({ preventScroll: true });
}

// open: { docId } or { itemKey }
async function openTab(open) {
  if (open.docId && open.docId === activeId() && !home.isOpen) return;
  savePosition();
  try {
    const r = await host.call('tab_open', open);
    tabs = r.tabs;
    showTab(r.active);
  } catch (e) {
    if (home.isOpen) home.note(e.message);
    else showMessage(e.message, true);
  }
}

async function closeTab(id) {
  if (id === doc?.id) savePosition();
  const r = await host.call('tab_close', { docId: id });
  tabs = r.tabs;
  if (id !== activeId()) return renderTabs();
  if (doc) leavePaper();
  hideNote();
  if (r.active) showTab(r.active);
  else showHome();
}

// A place the model asked to show (show_location), picked up by the poll.
async function follow(n) {
  if (n.docId !== doc?.id || home.isOpen) await openTab({ docId: n.docId });
  if (n.docId !== doc?.id) return;
  if (n.rects?.length) {
    reader.scrollToPoint(n.page, Math.min(...n.rects.map(r => r[1])));
    if (n.key) annotations.flash(n.key);
    else flashRects(n.page, n.rects);
  } else {
    reader.scrollToPage(n.page);
  }
  updateBar();
}

// Outlines the block of text at a jump target (the equation, the figure and its caption, …) in its column;
// fallback: the given rect.
function flashBlock(k, at, fallback) {
  selection.textFor(k)
    .then(text => targetBlock(text, text.lines, at) || fallback)
    .catch(() => fallback)
    .then(r => flashRects(k, [r]));
}

function flashRects(k, rects) {
  requestAnimationFrame(() => {
    const pg = reader.pages.get(k) || reader.ensurePage(k);
    const [rx, ry, rw, rh] = reader.region(k - 1);
    const nodes = rects.map(([x, y, w, h]) => {
      const n = document.createElement('div');
      n.className = 'flash';
      Object.assign(n.style, { left: `${((x - rx) / rw) * 100}%`, top: `${((y - ry) / rh) * 100}%`, width: `${(w / rw) * 100}%`, height: `${(h / rh) * 100}%` });
      pg.overlay.appendChild(n);
      return n;
    });
    setTimeout(() => nodes.forEach(n => n.remove()), 1600);
  });
}

// ---------- settings ----------

function openSettings() {
  ocr?.close();
  drawer?.close();
  closeToc();
  settings.open();
}

function closeSettings() {
  if (!settings?.isOpen) return;
  settings.close();
  $('scroller').focus({ preventScroll: true });
}

function toggleSettings() {
  settings.isOpen ? closeSettings() : openSettings();
}

// After the settings drawer saved something: the render mode, colors and keys take effect at once.
function applyPrefs(next) {
  const mode = prefs.renderMode;
  const ocrChanged = prefs.allowModelOcr !== next.allowModelOcr || prefs.mineruConfigured !== next.mineruConfigured;
  prefs = next;
  if (ocrChanged && reader?.doc) ocr?.refresh();
  keys = keymap(prefs.keys);
  if (prefs.renderMode !== mode) reader?.setMode(prefs.renderMode);
  blocks?.outline(null);
  blocks?.prefetch(range(...(reader?.doc ? reader.range(0) : [1, 0])));
  updateBar();
  popup?.render();
  drawer?.render();
}

// ---------- selection toolbar ----------

function onSelection(sel, final) {
  if (sel) popup.close();
  placeToolbar();
  if (final) { blocks?.outline(null); contexts?.selectionChanged(); conversation.schedule(); }
}

// Above the selection when there is room under the bar, otherwise below it; hidden when off screen.
function placeToolbar() {
  const tb = $('toolbar');
  const r = selection?.clientRect();
  if (!r || r.bottom < BAR || r.top > window.innerHeight) {
    tb.hidden = true;
    return;
  }
  tb.hidden = false;
  const w = tb.offsetWidth, h = tb.offsetHeight;
  const top = r.top - h - 6 >= BAR + 4 ? r.top - h - 6 : Math.min(window.innerHeight - h - 4, r.bottom + 6);
  const left = Math.max(4, Math.min(window.innerWidth - w - 4, (r.left + r.right) / 2 - w / 2));
  tb.style.top = `${top}px`;
  tb.style.left = `${left}px`;
}

// A short word in the toolbar itself; nothing pops up elsewhere.
function note(text) {
  const n = $('toolbarNote');
  n.textContent = text;
  n.hidden = false;
  placeToolbar();
  clearTimeout(note.timer);
  note.timer = setTimeout(() => { n.hidden = true; placeToolbar(); }, 1800);
}

// H / 1–9 (⇧ for underline) or the toolbar button. The highlight is drawn at once; Zotero gets it in the background.
// Resolves to the new annotation's key (null if it could not be made).
function highlightSelection(color = palette()[0].color, type = 'highlight') {
  const sel = selection?.current;
  if (!sel) return Promise.resolve(null);
  if (!annotations.available) {
    note('这篇 PDF 不是从 Zotero 打开的，批注无处保存');
    return Promise.resolve(null);
  }
  const pending = annotations.create(sel, { color, type });
  selection.clear();
  return pending.catch(e => {
    selection.set(sel);
    note(`高亮失败：${e.message}`);
    return null;
  });
}

// The toolbar's 评论: highlight and start typing the comment, in one step.
function commentSelection() {
  highlightSelection().then(key => {
    if (!key) return;
    popup.open(key);
    popup.edit();
  });
}

function jumpTo(a) {
  reader.scrollToPoint(a.page, Math.min(...a.rects.map(r => r[1])));
  annotations.flash(a.key);
  updateBar();
}

async function copySelection() {
  const text = selection?.current?.text || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The panel sandbox may deny the async clipboard; a selected textarea + copy still works.
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  note('已复制');
}

// ---------- debug line (⇧D), for acceptance measurements ----------

function pct(values, q) {
  if (!values.length) return '–';
  const a = [...values].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.round(q * (a.length - 1)))]);
}

function renderDebug() {
  if ($('debug').hidden || !reader) return;
  const m = reader.metrics;
  const f = m.frames;
  const fps = f.length ? Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)) : '–';
  const jank = f.length ? ((100 * f.filter(x => x > 20).length) / f.length).toFixed(1) : '–';
  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : '–';
  const img = reader.imageStats;
  $('debug').textContent = `${host.mode} · ${prefs.renderMode} · DPR ${window.devicePixelRatio} · 宽 ${reader.layout[0]?.w ?? '–'}px · `
    + `图片 ${img.loaded}/${img.loaded + img.failed} · `
    + `${fps}fps 卡顿 ${jank}% · 打开 ${m.openSharpMs ?? '–'}ms · 停后 p50 ${pct(m.sharpAfterScroll, 0.5)} p95 ${pct(m.sharpAfterScroll, 0.95)}ms · `
    + `缩放后 p50 ${pct(m.sharpAfterZoom, 0.5)} p95 ${pct(m.sharpAfterZoom, 0.95)}ms · 堆 ${mem}MB（含未回收）`;
  setTimeout(renderDebug, 500);
}

// ---------- keyboard ----------

// Rebindable actions (keys.mjs, settings drawer). Returns false when the action does not apply here, so
// the key keeps its usual meaning. Back and forward always take the key while a paper is open: the Codex
// app would otherwise go back a page itself.
function runAction(id) {
  const reading = !!reader?.doc && !!doc && !home.isOpen;
  const run = {
    back: () => reading && (goBack(), true),
    forward: () => reading && (links.goForward(), true),
    find: () => reading && (find.open(), true),
    gotoPage: () => reading && (openPageInput(), true),
    highlight: () => reading && !!selection.current && (highlightSelection(), true),
    drawer: () => (noteTab || doc) && !home.isOpen && (toggleDrawer(), true),
    zoomIn: () => reading && (reader.zoomBy(1.1), true),
    zoomOut: () => reading && (reader.zoomBy(1 / 1.1), true),
    fitWidth: () => reading && (reader.fitWidth(), true),
    crop: () => reading && (reader.toggleCrop(), true),
    undo: () => reading && (annotations.undo().then(key => key && annotations.flash(key)).catch(() => {}), true),
    closeTab: () => !!activeId() && !home.isOpen && (closeTab(activeId()), true),
    settings: () => (toggleSettings(), true),
    debug: () => reading && (($('debug').hidden = !$('debug').hidden), renderDebug(), true),
  }[id];
  return !!run?.();
}

function onKey(e) {
  if (e.key === 'Escape' && researchPanel && !$('researchPreview').hidden) { e.preventDefault(); researchPanel.closePreview(); return; }
  if (e.key === 'Escape' && researchPanel && !$('researchPanel').hidden) { e.preventDefault(); researchPanel.close(); return; }
  if (e.key === 'Alt') document.body.classList.add('alt');
  if (['annComment', 'findInput', 'search'].includes(e.target.id)) return; // these handle their own keys
  if (e.target.closest?.('#settings') && e.target.matches('input[type=text], input[type=password], textarea')) return;
  if (e.target.id === 'pageInput') {
    if (e.key === 'Enter') closePageInput(true);
    if (e.key === 'Escape') closePageInput(false);
    return;
  }
  if (e.key !== 'Escape' && e.target.matches?.('input, textarea, select')) return;
  // Fixed keys first: ⌘1–9 tabs, Esc, ⌘C, 1–9 colors.
  if (e.metaKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const t = e.code === 'Digit9' ? tabs.at(-1) : tabs[Number(e.code.slice(5)) - 1];
    if (t) {
      e.preventDefault();
      openTab({ docId: t.id });
    }
    return;
  }
  if (e.key === 'Escape') {
    if (home.isOpen) leaveHome();
    else if (!$('tocDrawer').hidden) closeToc();
    else if (find.isOpen) find.close();
    else if (popup.isOpen) popup.close();
    else if (!$('ocrPanel').hidden) ocr.close();
    else if (settings.isOpen) closeSettings();
    else if (drawer.isOpen) drawer.close();
    else selection?.clear();
    return;
  }
  if (e.metaKey && e.key === 'c' && selection?.current) {
    e.preventDefault();
    copySelection();
    return;
  }
  const action = actionFor(keys, comboOf(e));
  if (action && runAction(action)) {
    e.preventDefault();
    updateBar();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || !reader?.doc || home.isOpen) return;
  // Color keys use the physical key, so ⇧1 is still "1" on any layout; 1 is the palette's first color.
  const n = /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
  const color = n && palette()[n - 1]?.color;
  if (color && selection.current) {
    e.preventDefault();
    highlightSelection(color, e.shiftKey ? 'underline' : 'highlight');
    return;
  }
  if (popup.isOpen) {
    if (color) {
      e.preventDefault();
      return popup.setColor(color);
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      return popup.trash();
    }
  }
}

function toggleDrawer() {
  if (noteTab) return $('tocDrawer').hidden ? openToc() : closeToc();
  if (!drawer.isOpen) closeSettings();
  drawer.toggle();
}

// ---------- lifecycle ----------

async function poll() {
  try {
    const r = await host.call('panel_poll', { instance, seen: navSeen });
    if ('readerSession' in r && conversation.readerSession !== r.readerSession) {
      conversation.readerSession = r.readerSession; conversation.schedule();
    }
    if (r.prefsRevision !== undefined && r.prefsRevision !== prefsSeen) {
      prefsSeen = r.prefsRevision;
      applyPrefs((await host.call('prefs_get')).prefs);
      if (settings.isOpen) settings.render();
    }
    if (r.superseded) {
      conversation.retire();
      interactions?.destroy(); researchPanel?.destroy();
      annotations.stop();
      popup.close();
      drawer.close();
      find.reset();
      home.hide();
      reader?.destroy();
      doc = null;
      hideNote();
      $('bar').hidden = true;
      showMessage('阅读器已在新的面板中打开。');
      return;
    }
    if (r.nav) {
      navSeen = r.nav.seq;
      await follow(r.nav);
    }
  } catch { /* server restarting; try again */ }
  setTimeout(poll, timing.navPollMs);
}

async function start() {
  showMessage('正在打开…');
  try {
    const hello = await host.call('panel_hello', { instance });
    reader.remote = !!host.remote && hello.features?.wholePage===true;
    conversation.readerSession = hello.readerSession || null;
    prefs = hello.prefs;
    Object.assign(timing, host.remote ? remoteTiming : hello.timing || {});
    keys = keymap(prefs.keys);
    tabs = hello.tabs;
    navSeen = hello.navSeq;
    $('bar').hidden = false;
    if (hello.active) showTab(hello.active);
    else if (hello.error) showMessage(hello.error, true);
    else showHome();
  } catch (e) {
    showMessage(e.message, true);
  }
}

async function main() {
  host = await connect();
  reader = new Reader({
    scroller: $('scroller'),
    content: $('content'),
    call: host.call,
    remote: host.remote,
    topInset: BAR,
    onPage: page => {
      updateBar(page);
      conversation.schedule();
      blocks?.prefetch([page]);
    },
    onPageCreated: k => {
      annotations?.draw(k);
      find?.draw(k);
      selection?.draw(k);
      contexts?.draw(k);
    },
    onImageError: reason => showMessage(`页面图片无法显示：${reason}`, true),
    onIdle: position => {
      if (!doc) return;
      updateBar();
      selection.prefetch(range(...reader.range(0)));
      links.prefetch(range(...reader.range(0)));
      blocks?.prefetch(range(...reader.range(0)));
      contexts?.relayout();
      host.call('position_save', { docId: doc.id, ...position }).catch(() => {});
    },
  });
  annotations = new AnnotationLayer({ reader, call: host.call, onChange: () => {
    popup.render(); popup.place(); drawer.render();
    if (annotations.doc) conversation.setAnnotationStatus(annotations.doc.id, { count: annotations.items.length,
      comments: annotations.items.filter(a => a.comment).length, version: annotations.rev, pending: annotations.pending, error: annotations.error });
  } });
  const openUrl = url => (host.app ? host.app.openLink({ url }).catch(() => {}) : window.open(url, '_blank', 'noopener'));
  popup = new AnnotationPopup({ layer: annotations, openUrl, palette });
  drawer = new AnnotationDrawer({
    layer: annotations, onJump: jumpTo, onNote: key => openTab({ docId: `note:${key}` }), openUrl,
    listNotes: async () => (doc ? host.call('notes_list', { docId: doc.id }) : { notes: [], map: null }),
    generateMap: () => host.call('map_generate', { docId: doc.id }), palette,
  });
  settings = new Settings({ call: host.call, getPrefs: () => prefs, onChange: applyPrefs, openUrl });
  home = new Home({ call: host.call, onOpen: openTab, onLeave: leaveHome });
  selection = new Selection({
    reader, call: host.call, onChange: onSelection,
    onClick: (k, pt, event) => {
      const link = links.hit(k, pt);
      if (link) {
        popup.close();
        return links.follow(link);
      }
      const a = annotations.hit(k, pt);
      if (a) popup.open(a.key);
      else { popup.close(); blocks?.select(k, pt, event); }
    },
  });
  conversation = new Conversation({ host, reader, selection });
  const analysisNotice = message => {
    $('analysisNotice').textContent = message; $('analysisNotice').hidden = false;
    clearTimeout(analysisNotice.timer); analysisNotice.timer = setTimeout(() => { $('analysisNotice').hidden = true; }, 5000);
  };
  contexts = new ContextBlocks({ host, reader, selection, onChange: () => conversation.schedule(), onNote: analysisNotice,
    onNavigate: async item => {
      if (doc?.id !== item.docId || home.isOpen) await openTab({ docId: item.docId });
      if (doc?.id !== item.docId) throw new Error('无法打开这篇论文');
      reader.scrollToPoint(item.page, item.rect[1]); reader.refresh(); updateBar();
    } });
  conversation.contextBlocks = contexts;
  researchPanel = new ResearchPanel({ host, onChange: () => conversation.schedule(), prepare: async () => { await conversation.sync(); await conversation.publishQueue; analysisNotice('研究文献已加入上下文，请在 ChatGPT 对话框中提出问题'); } });
  conversation.research = researchPanel;
  blocks = new Blocks({ reader, selection, call: host.call, enabled: () => prefs.layoutEnabled !== false,
    onNote: analysisNotice, onAdd: () => contexts.add() });
  ocr = new OcrPanel({ reader, call: host.call, onError: analysisNotice, onStatus: (id, status) => conversation.setFullTextStatus(id, status), onChanged: () => {
    blocks.reset(); blocks.prefetch(range(...reader.range(0))); selection.texts.clear(); conversation.schedule();
  } });
  find = new Find({ reader, selection });
  links = new Links({
    reader, call: host.call, pointAt: (e, el, k) => selection.pointAt(e, el, k), textFor: k => selection.textFor(k), onMove: () => updateBar(),
    flash: (k, at, fallback) => flashBlock(k, at, fallback),
    openUrl,
  });
  bindBar();
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', e => { if (e.key === 'Alt') document.body.classList.remove('alt'); });
  window.addEventListener('blur', () => document.body.classList.remove('alt'));
  $('scroller').addEventListener('scroll', () => requestAnimationFrame(() => { placeToolbar(); popup.place(); }), { passive: true });
  // The toolbar must not take the click as a "click on the page", which would clear the selection.
  $('toolbar').addEventListener('mousedown', e => { if (!e.target.matches('input, textarea, select')) e.preventDefault(); e.stopPropagation(); });
  $('addContext').addEventListener('click', () => contexts.add());
  $('layoutButton').addEventListener('click', async () => {
    try { applyPrefs((await host.call('prefs_set', { layoutEnabled: prefs.layoutEnabled === false })).prefs); } catch(e) { analysisNotice(e.message); }
  });
  $('ocrButton').addEventListener('click', () => {
    if ($('ocrPanel').hidden) { closeSettings(); ocr.open(); } else ocr.close();
    $('ocrButton').setAttribute('aria-expanded', String(!$('ocrPanel').hidden));
  });
  $('comment').addEventListener('click', commentSelection);
  $('highlight').addEventListener('click', () => highlightSelection());
  $('annButton').addEventListener('click', toggleDrawer);
  $('back').addEventListener('click', goBack);
  $('noteView').addEventListener('click', onNoteClick);
  let noteScrollTimer = 0;
  $('noteView').addEventListener('scroll', () => {
    clearTimeout(noteScrollTimer);
    noteScrollTimer = setTimeout(saveNotePosition, 500);
  }, { passive: true });
  $('tocClose').addEventListener('click', closeToc);
  $('tocList').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (li) document.getElementById(li.dataset.id)?.scrollIntoView({ block: 'start' });
  });
  $('tabs').addEventListener('click', e => {
    if (e.target.closest('#newTab')) return showHome();
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (e.target.closest('i')) closeTab(tab.dataset.id).catch(err => showMessage(err.message, true));
    else openTab({ docId: tab.dataset.id });
  });
  $('tabs').addEventListener('auxclick', e => {
    const tab = e.target.closest('.tab');
    if (tab && e.button === 1) closeTab(tab.dataset.id).catch(() => {});
  });
  $('pageLabel').addEventListener('click', openPageInput);
  $('pageInput').addEventListener('blur', () => closePageInput(false));
  $('zoomLabel').addEventListener('click', () => { reader.fitWidth(); updateBar(); });
  $('settingsButton').addEventListener('click', toggleSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('retry').addEventListener('click', start);
  window.__research = researchPanel; window.__blocks = blocks; window.__contexts = contexts; window.__ocr = ocr;
  window.__reader = reader; // for acceptance tests that read metrics from the DOM
  window.__selection = selection;
  window.__annotations = annotations;
  window.__find = find;
  window.__links = links;
  await start();
  interactions = new Interactions({ host, reader, selection, conversation, contexts, openTab, showHome, notify: analysisNotice,
    showFile: opened => { tabs = opened.tabs; showTab(opened.active); } });
  interactions.start();
  if (host.app) host.app.onteardown = async () => {
    interactions.destroy(); researchPanel?.destroy();
    clearTimeout(conversation.timer);
    if (doc && reader.doc) await host.call('position_save', { docId: doc.id, ...reader.position() }).catch(() => {});
    annotations.stop();
    return {};
  };
  poll();
}

main().catch(e => showMessage(`启动失败：${e.message}`, true));
