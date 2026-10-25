// Codex Zotero reader: MCP server for the Codex panel.
//   Codex:       node dist/server.mjs                     (stdio MCP)
//   Preflight:   node dist/server.mjs --standalone (--pdf FILE | --item KEY)   → serves the panel over HTTP
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDER_MODES } from '../shared/layout.mjs';
import { DocumentAnalysis } from './analysis.mjs';
import { DocumentWorker } from './document-worker.mjs';
import { MinerU } from './mineru.mjs';
import { Annotations } from './annotations.mjs';
import { Documents, summary } from './documents.mjs';
import { HelperPool } from './helpers.mjs';
import { Renderer } from './render.mjs';
import { rectFromZotero } from '../shared/annotations.mjs';
import { annotationRef, childNotes, getNote, renderNote } from './notes.mjs';
import { buildOutline } from './outline.mjs';
import { PaperMaps } from './map.mjs';
import { ReadingNotes } from './reading.mjs';
import { Paper } from './paper.mjs';
import { State } from './state.mjs';
import { TextService } from './text.mjs';
import { modelTools } from './tools.mjs';
import { modelToolMetadata, modelToolResult } from './tool-policy.mjs';
import { resolvePdf, searchAnnotations, searchLibrary } from './zotero.mjs';
import { registerExtensions } from './extensions.mjs';
import { Research, researchTools, researchKeys } from './research.mjs';
import { startLocalBridge } from '../bridge/local.mjs';
import { bridgeDefinitions } from '../bridge/tools.mjs';
import { jsonFile } from './files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const URI = 'ui://codex-zotero/reader-v5.html';
const PREVIEW_URI = 'ui://codex-zotero/paper-preview-v1.html';
const SETTINGS_URI = 'ui://codex-zotero/settings-v1.html';
const entryIcon = ['light', 'dark'].map(theme => ({ theme, mimeType: 'image/svg+xml', sizes: ['any'],
  src: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="${theme === 'dark' ? '#f5f5f5' : '#242424'}" stroke-width="1.33"><path d="M10 5C7 3 4 3 2 4v12c3-1 5-1 8 1 3-2 5-2 8-1V4c-2-1-5-1-8 1Zm0 0v12"/></svg>`),
}));
let prefsRevision = 0;

const pool = new HelperPool(join(here, 'pdfkit-helper'), Number(process.env.CODEX_ZOTERO_HELPERS) || 4); // 4: zoom gets sharp in ~150ms instead of ~210ms (preflight)
const documents = new Documents({
  pool, cacheRoot: process.env.CODEX_ZOTERO_CACHE || join(homedir(), 'Library', 'Caches', 'codex-zotero'),
});
const renderer = new Renderer(pool);
const stateRoot = process.env.CODEX_ZOTERO_STATE || join(homedir(), '.codex', 'codex-zotero');
const state = new State(stateRoot);
// CODEX_ZOTERO_FAST=1 (the browser preflight only): shorter waits everywhere, so the checks need not sit through
// the real 3-second polls and 2-second retry backoff.
const FAST = process.env.CODEX_ZOTERO_FAST === '1';
const annotations = new Annotations({ root: stateRoot, palette: async () => (await state.prefs()).palette, ...(FAST ? { backoff: [200, 500, 1500, 3000, 6000] } : {}) });
// MuPDF text repair reuses the PyMuPDF environment the 0.12.0 prototype installed on this machine.
const text = new TextService({
  pool, script: join(here, 'text_server.py'),
  // The Python with PyMuPDF that install.mjs found; without it the text is PDFKit's alone (no glyph repair).
  python: process.env.CODEX_ZOTERO_PYTHON || '',
});

const analysis = new DocumentAnalysis({
  preferences: () => state.prefs(),
  worker: new DocumentWorker({ python: process.env.CODEX_ZOTERO_PYTHON || '', script: join(here, 'document_worker.py'),
    model: process.env.CODEX_ZOTERO_LAYOUT_MODEL || join(homedir(), '.cache', 'codex-zotero', 'models', 'pp-doclayout-v2.onnx') }),
  mineru: new MinerU({ api: process.env.CODEX_ZOTERO_MINERU_API || undefined, secretFile: join(stateRoot, 'mineru-secret.json') }),
});
async function readerPrefs() { return { ...await state.prefs(), mineruConfigured: await analysis.mineru.configured() }; }
text.ocrText = (doc, page) => analysis.pageText(doc, page);
const paper = new Paper(text);
const maps = new PaperMaps({ writer: annotations.writer, paper, pool, settings: () => state.prefs() });
const readingNotes = new ReadingNotes({ writer: annotations.writer, paper, pool, settings: () => state.prefs() });

const linkCache = new Map();
let activeInstance = null;  // every reader_open call makes Codex create a new panel (spike S5); only the newest one stays live
let lastPoll = 0;           // when the live panel last checked in
let live = null;            // what the panel reports: { docId, page, visible, selection } while a paper is on screen
let asked = null;           // { docId, selection, at }: the selection the user last asked about with the panel's 提问 button
let view = null;            // what the panel shows: { kind: 'paper' | 'note' | 'home', note?: { key, title } }
let nav = { seq: 0 };       // the latest "show this place" request from the model, picked up by the panel's poll

// Opens a PDF and makes it the active tab.
async function openSource(source) {
  const doc = await documents.open(source);
  await state.touch(doc);
  await state.openTab(doc.id);
  return doc;
}

async function docById(id) {
  if (documents.byId.has(id)) return documents.get(id);
  const record = await state.document(id);
  if (!record) throw new Error('未知文档。');
  return documents.reopen(record);
}

const noteTitles = new Map();

async function tabsView() {
  const t = await state.tabs();
  const tabs = [];
  for (const id of t.tabs) {
    if (id.startsWith('note:')) {
      const key = id.slice(5);
      if (!noteTitles.has(key)) noteTitles.set(key, await getNote(key).then(n => n.title).catch(() => '笔记'));
      tabs.push({ id, title: noteTitles.get(key), kind: 'note' });
      continue;
    }
    const r = await state.document(id);
    if (r) tabs.push({ id, title: r.title, kind: 'paper' });
  }
  return { tabs, active: tabs.some(x => x.id === t.active) ? t.active : null };
}

// A few seconds after a paper opens, read all its text and build its structure index in the background,
// at the lowest helper priority: ⌘F, find_in_paper, paper_outline and quotes then answer at once.
const warmed = new Set();
function warm(doc) {
  if (warmed.has(doc.id)) return;
  warmed.add(doc.id);
  setTimeout(async () => {
    try {
      for (let k = 1; k <= doc.pageCount; k++) await text.page(doc, k, 9);
      await buildOutline(doc, ctx);
    } catch {
      warmed.delete(doc.id);
    }
  }, 4000).unref?.();
}

async function opened(doc) {
  warm(doc);
  const record = await state.document(doc.id);
  return { document: summary(doc), position: record?.position ?? null };
}

async function openNote(key) {
  const n = await getNote(key);
  noteTitles.set(key, n.title);
  return { note: { key, id: `note:${key}`, title: n.title, parentItem: n.parentItem, position: await state.notePosition(key), ...(await renderNote(n.html)) } };
}

// What a tab shows: a paper ({ document, position }) or a note ({ note }).
const openedTab = async id => (id.startsWith('note:') ? openNote(id.slice(5)) : opened(await docById(id)));

// The document a model tool acts on: the one asked for, else the one on screen.
// The paper tab a tool should act on when the active tab is a note: the one opened most recently.
async function paperTab() {
  const { tabs, active } = await state.tabs();
  if (active && !active.startsWith('note:')) return active;
  const papers = tabs.filter(id => !id.startsWith('note:'));
  if (!papers.length) return null;
  const recent = await state.recent(50);
  return recent.find(r => papers.includes(r.id))?.id ?? papers.at(-1);
}

async function activeDoc(docId) {
  if (docId) return docById(docId);
  const id = live?.docId || (await paperTab());
  if (!id) throw new Error('阅读器里没有打开的论文；先用 search_library 找到论文，再用 reader_open 打开。');
  return docById(id);
}

async function navigate(doc, target) {
  await state.openTab(doc.id);
  nav = { seq: nav.seq + 1, docId: doc.id, ...target };
  return Date.now() - lastPoll < 5000;
}

// Background research resolves papers without opening or replacing the active tab.
const researchDocs = new Map();
async function researchDoc(itemKey, { remember = true } = {}) {
  let entry = researchDocs.get(itemKey);
  if (!entry || Date.now() - entry.at >= 30000) {
    entry = { at: Date.now(), remembered: false,
      promise: resolvePdf({ itemKey }).then(source => documents.open(source, { background: true })) };
    researchDocs.set(itemKey, entry);
  }
  try {
    const doc = await entry.promise;
    // Rendering a search thumbnail must not populate the user's reading history.
    if (remember && !entry.remembered) { await state.touch(doc); entry.remembered = true; }
    return doc;
  } catch(e) { researchDocs.delete(itemKey); throw e; }
}

const research = new Research({ resolve: researchDoc, analysis, annotations, renderer, search: searchLibrary, recent: () => state.recent(20) });

const ctx = {
  analysis, annotations, maps, readingNotes, paper, pool, state, docById, activeDoc, paperTab, tabsView, view: () => view, navigate, searchLibrary, searchAnnotations, live: () => live, asked: () => asked };
const forModel = modelTools(ctx);
const forResearch = researchTools(research);
let chatBridge = null;
if (argv.includes('--chat-bridge') || (await jsonFile(join(stateRoot, 'chat-bridge-enabled.json'), {})).enabled === true) {
  chatBridge = await startLocalBridge({ root:stateRoot, definitions:bridgeDefinitions({...forModel,...forResearch}),
    describe:async()=>{
      const record=live?.docId ? await state.document(live.docId) : null;
      return { document:record ? {docId:live.docId,title:record.title,itemKey:record.itemKey} : null,
        live:Date.now()-lastPoll<15000 };
    },
  });
}

const CAPTION_KIND = { fig: '图', tab: '表', alg: '算法' };
async function outlineX(doc, page, y, kind) {
  const o = await buildOutline(doc, ctx).catch(() => null);
  if (!o) return null;
  const list = kind === 'eq' ? o.equations : o.captions.filter(c => c.kind === CAPTION_KIND[kind]);
  const hit = list.filter(e => e.page === page && Math.abs(e.y - y) <= 12).sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
  return hit?.x ?? null;
}

const appTools = {
  async research_choose({ query = '' }) { return { requiresSelection: true, papers: await research.candidates(query) }; },
  async research_candidates({ query = '' }) { return { papers: await research.candidates(query) }; },
  async research_prepare({ itemKeys }) { return research.status(itemKeys); },
  async research_preview_data({ itemKey, page = 1, detail = false }) { return research.preview(itemKey, page, detail); },
  ...Object.fromEntries(Object.entries(forResearch).map(([name, tool]) => [name, tool.run])),
  async layout_page({ docId, page }) { return analysis.layout(documents.get(docId), page); },
  async ocr_job_status({ docId }) { return analysis.status(documents.get(docId)); },
  async ocr_job_start({ docId, force }) { return analysis.start(documents.get(docId), { force }); },
  async ocr_job_cancel({ docId }) { return analysis.cancel(documents.get(docId)); },
  async mineru_configure({ apiKey }) { await analysis.mineru.configure(apiKey); prefsRevision++; return { prefs: await readerPrefs() }; },
  async document_file({ docId }) { return { path: (await docById(docId)).path }; },
  async file_open(_args, extra) {
    const path = extra?._meta?.['openai/resource']?.path;
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('宿主未提供已授权的 PDF 文件，请从 Zotero 打开。');
    const doc = await openSource({ path });
    return { ...(await tabsView()), active: await opened(doc) };
  },
  async prefs_get() { return { prefs: await readerPrefs() }; },
  async panel_hello({ instance }) {
    activeInstance = instance;
    lastPoll = Date.now();
    const view = await tabsView();
    let active = null;
    let error = null;
    if (view.active) {
      try {
        active = await openedTab(view.active);
      } catch (e) {
        error = e.message;
      }
    }
    return { prefs: await readerPrefs(), ...view, active, error, navSeq: nav.seq, readerSession:chatBridge?.id || null, ...(FAST ? { timing: { navPollMs: 200, annotationsPollMs: 300, mapPollMs: 300 } } : {}) };
  },
  async panel_poll({ instance, seen = 0 }) {
    const superseded = activeInstance !== null && instance !== activeInstance;
    if (!superseded) lastPoll = Date.now();
    return { superseded, prefsRevision, nav: !superseded && nav.seq > seen ? nav : null };
  },
  async tab_open({ docId, itemKey }) {
    if (docId?.startsWith('note:')) {
      const active = await openNote(docId.slice(5));
      await state.openTab(docId);
      return { ...(await tabsView()), active };
    }
    const doc = itemKey ? await openSource(await resolvePdf({ itemKey })) : await docById(docId);
    if (!itemKey) {
      await state.touch(doc);
      await state.openTab(doc.id);
    }
    return { ...(await tabsView()), active: await opened(doc) };
  },
  async tab_close({ docId }) {
    await state.closeTab(docId);
    const view = await tabsView();
    return { ...view, active: view.active ? await openedTab(view.active) : null };
  },
  async note_position_save({ key, top }) {
    await state.saveNotePosition(key, top);
    return { saved: true };
  },
  async notes_list({ docId }) {
    const doc = documents.get(docId);
    return { notes: doc.itemKey ? await childNotes(doc.itemKey) : [], map: { ...maps.status(doc), available: !!doc.itemKey } };
  },
  // The paper map is made only when the user asks (drawer button or the conversation).
  async map_generate({ docId }) {
    return maps.start(documents.get(docId));
  },
  // A highlight quoted in a note → open its PDF and return where it is, in reader coordinates.
  // From a note back into a PDF: a quoted highlight (ref) or a zotero://open-pdf link (attachmentKey, page,
  // optionally y and kind of what is there). Opens the paper as a tab and says where to go.
  async note_jump({ ref, attachmentKey, page, x, y, kind }) {
    const at = ref ? annotationRef(ref) : { attachmentKey, pageIndex: page - 1, rects: null };
    if (!at) throw new Error('无法识别这处引用。');
    const doc = await openSource(await resolvePdf({ itemKey: at.attachmentKey }));
    const g = doc.pages[at.pageIndex];
    if (!g) throw new Error('引用的页码超出范围。');
    // Links written before they carried x (maps made earlier) say only the height: on a two-column page that
    // is ambiguous, so the column is taken from the structure index entry at that height.
    if (x == null && y != null && kind) x = await outlineX(doc, at.pageIndex + 1, y, kind);
    const target = { page: at.pageIndex + 1, rects: at.rects ? at.rects.map(r => rectFromZotero(g, r)) : null, x: x ?? null, y: y ?? null, kind: kind ?? null };
    return { ...(await tabsView()), active: await opened(doc), target };
  },
  async tab_order({ tabs, active }) {
    await state.setTabs({ tabs, active });
    return tabsView();
  },
  async home_list({ query }) {
    if (query?.trim()) return { results: await searchLibrary(query, 20) };
    const recent = await state.recent(20);
    return { recent: recent.map(r => ({ id: r.id, title: r.title, itemKey: r.itemKey, page: r.position?.page ?? null, pageCount: r.pageCount ?? null, lastRead: r.lastRead ?? r.lastOpened })) };
  },
  async panel_report(report) {
    const { asked: q, ...rest } = report;
    live = rest.docId ? { ...rest, at: Date.now() } : null; // a note or the home page: no paper on screen
    // The selection a question was sent about stays usable for saving the answer, even once the user has
    // clicked elsewhere and the live selection is gone.
    if (q && rest.docId) asked = { docId: rest.docId, selection: q, at: Date.now() };
    view = report.docId ? { kind: 'paper' } : { kind: report.view === 'note' ? 'note' : 'home', note: report.note ?? null };
    return { ok: true };
  },
  async render_strip(args) {
    const r = await renderer.strip(documents.get(args.docId), args);
    return { data: r.data, index: r.strip.index };
  },
  async render_preview(args) {
    return renderer.preview(documents.get(args.docId), args);
  },
  async position_save({ docId, page, offset, zoom }) {
    await state.savePosition(docId, { page, offset, zoom });
    return { saved: true };
  },
  async prefs_set(patch) {
    await state.setPrefs(patch);
    prefsRevision++;
    return { prefs: await readerPrefs() };
  },
  async page_text({ docId, page }) {
    return text.page(documents.get(docId), page);
  },
  async selection_image({ docId, page, rect, scale }) {
    return renderer.crop(documents.get(docId), { page, rect, scale });
  },
  // Links of a page: { rect, page?, point?: [x|null, y|null] } for jumps inside the paper, { rect, url } for the web.
  async page_links({ docId, page }) {
    const doc = documents.get(docId);
    if (page < 1 || page > doc.pageCount) throw new Error('页码超出范围。');
    const key = `${doc.id}:${page}`;
    if (!linkCache.has(key)) linkCache.set(key, pool.run(doc.path, { op: 'links', page }, 2).then(r => r.links).catch(e => { linkCache.delete(key); throw e; }));
    return { links: await linkCache.get(key) };
  },
  async annotations_list({ docId, since }) {
    return annotations.list(documents.get(docId), { since });
  },
  // Writes return the list right away (with the write still queued), so the panel never waits on Zotero.
  async annotation_create({ docId, kind, page, rects, text, offset, color, type }) {
    const doc = documents.get(docId);
    const key = await annotations.create(doc, { kind, page, rects, text, offset }, { color, type });
    return { key, ...(await annotations.list(doc)) };
  },
  async annotation_update({ docId, key, comment, color }) {
    const doc = documents.get(docId);
    await annotations.update(doc, key, { comment, color });
    return annotations.list(doc);
  },
  async annotation_delete({ docId, key }) {
    const doc = documents.get(docId);
    await annotations.remove(doc, key);
    return annotations.list(doc);
  },
  async annotation_undo({ docId }) {
    const doc = documents.get(docId);
    const key = await annotations.undoDelete(doc);
    return { key, ...(await annotations.list(doc)) };
  },
  async annotation_retry({ docId, id, discard }) {
    if (discard) await annotations.writer.discard(id);
    else await annotations.writer.retry(id);
    return annotations.list(documents.get(docId));
  },
};

const rect = z.array(z.number()).length(4);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const selectionSchema = z.object({
  kind: z.enum(['text', 'region']), page: z.number().int().min(1), text: z.string().max(20000).optional(),
  rects: z.array(rect).max(200).optional(), rect: rect.optional(), a: z.number().int().optional(),
});
const appSchemas = {
  research_choose: { query: z.string().max(200).default('') },
  research_candidates: { query: z.string().max(200).default('') },
  research_prepare: { itemKeys: researchKeys },
  research_preview_data: { itemKey: z.string().regex(/^[A-Z0-9]{8}$/), page: z.number().int().min(1).default(1), detail: z.boolean().default(false) },
  ...Object.fromEntries(Object.entries(forResearch).map(([name, tool]) => [name, tool.schema])),
  document_file: { docId: z.string() },
  file_open: {},
  layout_page: { docId: z.string(), page: z.number().int().min(1) },
  ocr_job_status: { docId: z.string() },
  ocr_job_start: { docId: z.string(), force: z.boolean().optional() },
  ocr_job_cancel: { docId: z.string() },
  mineru_configure: { apiKey: z.string().min(1).max(4096) },
  prefs_get: {},
  panel_hello: { instance: z.string().max(40) },
  panel_poll: { instance: z.string().max(40), seen: z.number().int().min(0).optional() },
  tab_open: { docId: z.string().optional(), itemKey: z.string().regex(/^[A-Z0-9]{8}$/).optional() },
  tab_close: { docId: z.string() },
  tab_order: { tabs: z.array(z.string()).max(20), active: z.string().nullable() },
  home_list: { query: z.string().max(200).optional() },
  notes_list: { docId: z.string() },
  map_generate: { docId: z.string() },
  note_position_save: { key: z.string().regex(/^[A-Z0-9]{8}$/), top: z.number().min(0).max(1) },
  note_jump: {
    ref: z.string().max(20000).optional(), attachmentKey: z.string().regex(/^[A-Z0-9]{8}$/).optional(), page: z.number().int().min(1).optional(),
    x: z.number().optional(), y: z.number().optional(), kind: z.enum(['eq', 'fig', 'tab', 'alg']).optional(),
  },
  panel_report: {
    view: z.enum(['paper', 'note', 'home']).optional(), note: z.object({ key: z.string(), title: z.string() }).nullable().optional(),
    docId: z.string().nullable(), page: z.number().int().min(1).optional(), visible: z.array(z.number().int()).length(2).optional(),
    selection: selectionSchema.nullable().optional(),
    asked: selectionSchema.optional(),
  },
  render_strip: {
    docId: z.string(), page: z.number().int().min(1), mode: z.enum(RENDER_MODES), cssWidth: z.number().positive().max(8000),
    dpr: z.number().positive().max(4), index: z.number().int().min(0), crop: z.boolean().optional(), priority: z.number().int().min(0).max(3).optional(),
  },
  render_preview: { docId: z.string(), page: z.number().int().min(1), crop: z.boolean().optional() },
  position_save: { docId: z.string(), page: z.number().int().min(1), offset: z.number(), zoom: z.number() },
  prefs_set: {
    allowModelOcr: z.boolean().optional(),
    layoutEnabled: z.boolean().optional(),
    renderMode: z.enum(RENDER_MODES).optional(),
    palette: z.array(z.object({ color: z.string(), tag: z.string() })).max(9).nullable().optional(),
    keys: z.record(z.string(), z.string().nullable()).optional(),
    mapPrompt: z.string().max(20000).optional(), mapModel: z.string().max(60).optional(), mapEffort: z.enum(['', 'low', 'medium', 'high']).optional(), readingQuestions: z.string().max(20000).optional(),
  },
  page_text: { docId: z.string(), page: z.number().int().min(1) },
  selection_image: { docId: z.string(), page: z.number().int().min(1), rect, scale: z.number().positive().max(3).optional() },
  page_links: { docId: z.string(), page: z.number().int().min(1) },
  annotations_list: { docId: z.string(), since: z.string().optional() },
  annotation_create: {
    docId: z.string(), kind: z.enum(['text', 'region']), page: z.number().int().min(1), rects: z.array(rect).min(1).max(200),
    text: z.string().max(20000).optional(), offset: z.number().int().min(0).optional(), color: color.optional(), type: z.enum(['highlight', 'underline']).optional(),
  },
  annotation_update: { docId: z.string(), key: z.string().regex(/^[A-Z0-9]{8}$/), comment: z.string().max(20000).optional(), color: color.optional() },
  annotation_delete: { docId: z.string(), key: z.string().regex(/^[A-Z0-9]{8}$/) },
  annotation_undo: { docId: z.string() },
  annotation_retry: { docId: z.string(), id: z.string().optional(), discard: z.boolean().optional() },
};

async function openReader({ itemKey, attachmentKey } = {}) {
  const tabs = await tabsView();
  const note = !itemKey && tabs.active?.startsWith('note:') ? tabs.tabs.find(t => t.id === tabs.active) : null;
  const doc = itemKey ? await openSource(await resolvePdf({ itemKey, attachmentKey })) : tabs.active && !note ? await docById(tabs.active) : null;
  const text = note ? `已打开阅读器，当前标签是笔记《${note.title}》（${note.id}）。`
    : doc ? `已在阅读器中打开《${doc.title}》，共 ${doc.pageCount} 页（docId ${doc.id}）。`
    : '阅读器已打开，显示首页（在读列表和搜索）。要打开某篇论文，可先用 search_library 找到 Zotero 条目 key。';
  return { text, document: doc && { id: doc.id, title: doc.title, itemKey: doc.itemKey, pageCount: doc.pageCount } };
}

async function shutdown() {
  await chatBridge?.close();
  research.close();
  analysis.close();
  pool.close();
  text.close();
  process.exit(0);
}

if (argv.includes('--standalone')) {
  // Browser preflight: same panel, tools reached over HTTP instead of the Codex host bridge.
  if (option('--pdf')) await openSource({ path: option('--pdf') });
  else if (option('--item')) await openSource(await resolvePdf({ itemKey: option('--item') }));
  const http = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/paper-preview')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await readFile(join(here, 'paper-preview.html'), 'utf8')); }
      if (req.url === '/panel') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Mirror what the Codex panel sandbox allows, so the preflight fails where Codex would:
        // images only as data: (no blob:, no http — spike S1 and phase 1 acceptance).
        res.setHeader('Content-Security-Policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'");
        return res.end(await readFile(join(here, 'panel.html')));
      }
      if (req.url === '/settings') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(await readFile(join(here, 'settings.html')));
      }
      if (req.url === '/host') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(await readFile(join(here, 'host.html')));
      }
      if (req.url === '/api/tool' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const { name, arguments: args = {} } = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        try {
          const tool = forModel[name] || forResearch[name];
          if (tool) return res.end(JSON.stringify(modelToolResult(name, await tool.run(z.object(tool.schema).parse(args)))));
          if (!appTools[name]) throw new Error('Unknown tool');
          return res.end(JSON.stringify({ content: [], structuredContent: await appTools[name](z.object(appSchemas[name]).parse(args)) }));
        } catch(e) { return res.end(JSON.stringify({ isError: true, content: [{type:'text',text:e.message}] })); }
      }
      if (req.url === '/api/call' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { name, arguments: args } = JSON.parse(body);
        if (!appTools[name]) throw new Error(`unknown tool ${name}`);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(await appTools[name](args || {})));
      }
      // The model's tools, for the preflight: { name, arguments } → { text, data } or { error }.
      if (req.url === '/api/model' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { name, arguments: args } = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        try {
          return res.end(JSON.stringify(await ({...forModel,...forResearch})[name].run(args || {})));
        } catch (e) {
          return res.end(JSON.stringify({ error: e.message }));
        }
      }
      res.statusCode = 404;
      res.end();
    } catch (e) {
      res.statusCode = 500;
      res.end(e.message);
    }
  });
  http.listen(Number(option('--port') || 0), '127.0.0.1', () => {
    process.stderr.write(`standalone panel: http://127.0.0.1:${http.address().port}/panel\n`);
  });
  process.on('SIGTERM', shutdown);
} else {
  const server = new McpServer({ name: 'codex-zotero', version: '0.1.0', icons: entryIcon });
  const ok = (data, text = 'ok') => ({ content: [{ type: 'text', text }], structuredContent: data });
  const fail = e => ({ isError: true, content: [{ type: 'text', text: e.message }] });
  registerExtensions(server, { state, searchLibrary, research, prefsChanged: () => { prefsRevision++; } });

  registerAppResource(server, 'reader', URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(join(here, 'panel.html'), 'utf8'),
      _meta: {
        ui: { prefersBorder: false },
        'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' },
      },
    }],
  }));

  registerAppResource(server, 'paper-preview', PREVIEW_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
    uri: PREVIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(join(here, 'paper-preview.html'), 'utf8'),
    _meta: { ui: { prefersBorder: false }, 'openai/ui': { availableDisplayModes: ['inline','fullscreen'], preferredDisplayMode: 'inline' } },
  }] }));
  registerAppTool(server, 'research_preview', {
    title: '论文预览', description: 'Preview a selected Zotero paper without replacing the active reader or starting OCR.',
    inputSchema: { itemKey: z.string().regex(/^[A-Z0-9]{8}$/), page: z.number().int().min(1).default(1) },
    annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: PREVIEW_URI, visibility: ['app'] } },
  }, async ({itemKey,page}) => {
    try { return ok(await research.preview(itemKey,page,true)); } catch(e) { return fail(e); }
  });

  registerAppResource(server, 'settings', SETTINGS_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
    uri: SETTINGS_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(join(here, 'settings.html'), 'utf8'),
    _meta: { ui: { prefersBorder: false }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' } },
  }] }));
  registerAppTool(server, 'reader_settings', {
    title: '设置与 MinerU 密钥', description: 'Open private reader settings. Credentials are entered only in the app.', inputSchema: {},
    annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: SETTINGS_URI, visibility: ['app'] } },
  }, async () => ok({ view: 'settings' }));
  registerAppTool(server, 'reader_library', {
    title: 'Zotero 文库', description: 'Browse the Zotero library.', inputSchema: {}, annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global', quickAction: { title: '继续阅读', icons: entryIcon, target: { type: 'tool', name: 'reader_resume', arguments: {} } } }] } },
  }, async () => ok({ view: 'library' }));
  registerAppTool(server, 'reader_resume', {
    title: '继续阅读', description: 'Resume the last open paper or note in the reader. Show the library when no tab is open.',
    inputSchema: {}, annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
  }, async () => {
    try {
      const tabs = await tabsView();
      const active = tabs.active ? await openedTab(tabs.active) : null;
      return ok({ ...tabs, view: active ? 'reader' : 'library', active });
    } catch (e) { return fail(e); }
  });
  registerAppTool(server, 'reader_file', {
    title: '用 Zotero 阅读器打开 PDF', description: 'Read a PDF authorized by the host file viewer.',
    inputSchema: { file: z.object({ name: z.string().min(1), resourceUri: z.string().min(1) }) },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.pdf'] }] } },
  }, async ({ file }) => ok({ view: 'file', file }));

  registerAppTool(server, 'reader_open', {
    title: 'Zotero 阅读器',
    description: 'Open the Zotero paper reader panel in Codex. Pass itemKey (the 8-character Zotero key of a paper or of its PDF attachment, e.g. from search_library) to open that paper in a tab; omit it to show the reader as the user left it. Each call opens a new panel, so to move within a paper already open use show_location instead.',
    inputSchema: { itemKey: z.string().regex(/^[A-Z0-9]{8}$/).optional(), attachmentKey: z.string().regex(/^[A-Z0-9]{8}$/).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: URI, visibility: ['app', 'model'] },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    },
  }, async args => {
    try {
      const r = await openReader(args);
      return ok({ document: r.document }, r.text);
    } catch (e) {
      return fail(e);
    }
  });

  for (const [name, run] of Object.entries(appTools)) {
    if (forResearch[name] || name === 'research_choose') continue;
    registerAppTool(server, name, {
      description: `Reader panel internal: ${name}`, inputSchema: appSchemas[name],
      _meta: { ui: { resourceUri: URI, visibility: ['app'] } },
    }, async (args, extra) => {
      try {
        return ok(await run(args, extra));
      } catch (e) {
        return fail(e);
      }
    });
  }

  for (const [name, tool] of Object.entries({ ...forModel, ...forResearch })) {
    server.registerTool(name, { description: tool.description, inputSchema: tool.schema, ...modelToolMetadata(name) }, async args => {
      try { return modelToolResult(name, await tool.run(args)); }
      catch (e) { return fail(e); }
    });
  }

  await server.connect(new StdioServerTransport());
  // Without this the helper processes would outlive Codex closing the pipe.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}
