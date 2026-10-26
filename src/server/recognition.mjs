// Enhanced recognition: MinerU reads the whole PDF — formulas as LaTeX, tables with their
// structure, the reading order of two columns, exact boxes of equations, figures and tables. A supplement to the
// glyph layer, never a replacement: rendering, selection and annotation positions still come from PDFKit.
//
// Only on the user's word: the master switch in the settings (every paper opened in the reader), a click on the
// status icon, or the user's explicit request in the conversation (the model tool). The backend is MinerU's V1 API, either the official
// service or the user's self-hosted one (mineru-kit api-server); the self-hosted one is tried first and falls back
// to the official service only when the user allowed it.
//
// Results are kept for good in Application Support, per PDF fingerprint: MinerU's ZIP as returned, minus its
// copy of the PDF, and index.json — the per-page text and blocks the tools read.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recognizedCaptions } from '../shared/blocks.mjs';
import { atomicJSON, jsonFile } from './files.mjs';

export const OFFICIAL_API = process.env.CODEX_ZOTERO_MINERU_API || 'https://mineru.net/api/';
const INDEX_VERSION = 2; // 2: captions, caption boxes, image paths and tables as Markdown (for jumps and the debug view)
const MAX_PDF = 200 * 1024 * 1024; // MinerU's limits: 200 MB and 200 pages per file
const MAX_PAGES = 200;
const MAX_ZIP = 512 * 1024 * 1024;
const TIMEOUT_MS = 15 * 60 * 1000;
const SKIP = new Set(['header', 'footer', 'page_number', 'page_footnote', 'aside_text']);

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts }, (e, out) => (e ? reject(e) : resolve(out)));
});

// A table as plain rows: HTML (official) loses its tags; a Markdown table (self-hosted) is kept as it is.
const plain = t => (!/<[a-z]/i.test(String(t || '')) ? String(t || '').trim() : String(t).replace(/<\/(tr|p)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/ ?\| ?\n/g, '\n').trim());
const lines = a => (Array.isArray(a) ? a.filter(Boolean).join(' ') : String(a || ''));
const unescapeHtml = s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// A table as Markdown, for copying: HTML (official) row by row (merged cells are not spread); Markdown as it is.
function markdownTable(t) {
  const body = String(t || '');
  if (!/<tr/i.test(body)) return body.trim();
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => unescapeHtml(c[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
  const n = Math.max(0, ...rows.map(r => r.length));
  if (!n) return plain(body);
  const row = r => `| ${[...r, ...Array(n - r.length).fill('')].join(' | ')} |`;
  return [row(rows[0]), `| ${Array(n).fill('---').join(' | ')} |`, ...rows.slice(1).map(row)].join('\n');
}
// An equation number as printed: 12, 7a, A.1, 3-2; MinerU sometimes tags a formula with dots or words.
const LABEL = /^(?:[A-Z]\.?)?\d{1,3}(?:[.-]\d{1,3})?[a-z]?$/;
// 0–1000 box → page points [x, y, w, h], one decimal.
const toRect = (bbox, size) => {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return undefined;
  const [x0, y0, x1, y1] = [bbox[0] * size.width / 1000, bbox[1] * size.height / 1000, bbox[2] * size.width / 1000, bbox[3] * size.height / 1000];
  return [x0, y0, x1 - x0, y1 - y0].map(v => Math.round(v * 10) / 10);
};

// MinerU's content_list.json → { pages: [{ text, blocks: [{ type, rect, text, level?, latex?, labels?, caption?,
// captionRect?, img?, table? }] }] }, blocks in MinerU's reading order. Boxes come in 0–1000 of the page; rects are
// page points from the top left, as everywhere in the reader. captionRect only where the source has one (self-hosted).
export function buildIndex(list, pages) {
  const out = pages.map(() => ({ text: [], blocks: [] }));
  for (const b of list) {
    const page = out[b.page_idx];
    const size = pages[b.page_idx];
    if (!page || !size) continue;
    let text = '';
    const block = { type: b.type };
    if (b.type === 'equation') {
      const latex = String(b.text || '').replace(/^\s*\$\$\s*|\s*\$\$\s*$/g, '').trim();
      // One block can hold several numbered lines: "… \\tag {7a}\\tag{7b}".
      const labels = [...latex.matchAll(/\\tag\s*\{([^}]{1,12})\}/g)].map(m => m[1].replace(/[()\s]/g, '')).filter(l => LABEL.test(l));
      Object.assign(block, { latex, ...(labels.length ? { labels } : {}) });
      text = `$$\n${latex}\n$$`;
    } else if (b.type === 'image' || b.type === 'chart') {
      const caption = lines(b.image_caption || b.chart_caption);
      Object.assign(block, caption ? { caption } : {}, b.img_path ? { img: String(b.img_path) } : {});
      text = caption ? `[图] ${caption}` : '';
    } else if (b.type === 'table') {
      const caption = lines(b.table_caption);
      Object.assign(block, caption ? { caption } : {}, { table: markdownTable(b.table_body) });
      text = [caption, plain(b.table_body), lines(b.table_footnote)].filter(Boolean).join('\n');
    } else if (b.type === 'code') {
      const caption = lines(b.code_caption);
      if (caption) block.caption = caption;
      text = [caption, String(b.code_body || '').replace(/^```\w*\n?|```\s*$/g, '')].filter(Boolean).join('\n');
    } else if (b.type === 'list') {
      text = (b.list_items || []).join('\n');
    } else {
      text = String(b.text || '');
      if (b.text_level) {
        block.level = b.text_level;
        text = `${'#'.repeat(Math.min(4, b.text_level + 1))} ${text}`;
      }
    }
    const rect = toRect(b.bbox, size);
    const captionRect = toRect(b.caption_bbox, size);
    if (rect) block.rect = rect;
    if (captionRect) block.captionRect = captionRect;
    block.text = text;
    page.blocks.push(block);
    if (text.trim() && !SKIP.has(b.type)) page.text.push(text.trim());
  }
  return out.map(p => ({ text: p.text.join('\n\n'), blocks: p.blocks }));
}

// The self-hosted service (mineru-kit) has no content_list; its structured_content.json holds the same blocks
// with 0–1 boxes and Markdown / LaTeX content. Turned into content_list items, so one indexer serves both.
export function fromStructured(sc) {
  const caps = a => (a || []).map(c => (typeof c === 'string' ? c : c?.content || ''));
  const box = bb => (Array.isArray(bb) && bb.length === 4 ? bb.map(v => v * 1000) : null);
  // The caption's box: its lines together, without the sub-figure letters ("a", "(b)") that sit on the pictures.
  const captionBox = cs => {
    const bs = (cs || []).filter(c => String(c?.content || '').trim().length > 3).map(c => box(c.bbox)).filter(b => b?.every(Number.isFinite));
    return bs.length ? [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))] : undefined;
  };
  const items = [];
  for (const p of sc.pages || []) {
    for (const b of p.blocks || []) {
      const it = { type: b.type, page_idx: p.page_idx, bbox: box(b.bbox) || undefined, caption_bbox: captionBox(b.captions) };
      if (b.image_source) it.img_path = b.image_source;
      const c = typeof b.content === 'string' ? b.content : '';
      if (b.type === 'equation') it.text = `$$\n${c}\n$$`;
      else if (b.type === 'image' || b.type === 'chart') it.image_caption = caps(b.captions);
      else if (b.type === 'table') Object.assign(it, { table_caption: caps(b.captions), table_body: c, table_footnote: caps(b.footnotes) });
      else if (b.type === 'code') Object.assign(it, { code_caption: caps(b.captions), code_body: c });
      else if (b.type === 'doc_title' || b.type === 'paragraph_title') Object.assign(it, { type: 'text', text: c, text_level: b.level || 1 });
      else it.text = c;
      items.push(it);
    }
  }
  return items;
}

// Errors written here are shown to the user; anything else (a network exception) may quote a signed URL, so it
// is replaced by a plain sentence.
class Said extends Error {}
const plainError = e => (e instanceof Said ? e.message : e?.name === 'TimeoutError' ? '网络超时，请稍后重试。' : '网络错误，请检查网络后重试。');

// A response body read up to a limit, so a wrong or hostile server can't fill the memory.
async function limited(res, max) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > max) throw new Said('结果文件过大。');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
// The service root of a self-hosted MinerU (https://mineru.example.org, not …/v1).
const selfApi = url => `${url.replace(/\/+$/, '').replace(/\/v1$/, '')}/`;
// Only https (http for a service on this machine), no credentials in the URL.
const checked = (value, api) => {
  const u = new URL(value, api);
  if ((u.protocol !== 'https:' && !(LOOPBACK.includes(u.hostname) && u.protocol === 'http:')) || u.username || u.password) throw new Said('MinerU 返回了无效的地址。');
  return u;
};

// One recognition through MinerU's V1 API, the same on mineru.net and a self-hosted mineru-kit: create an upload
// (with the PDF's SHA-256, so a file MinerU already has is not sent again) → PUT the bytes → complete → submit a
// parse job asking for the ZIP → poll → download it. The key goes only to the API's own origin: the official
// upload URL is pre-signed object storage, and a redirect to another origin is followed without it.
async function recognizeV1({ api, key, pdf, sha256, name, fetch, poll, progress, deadline }) {
  const base = new URL(api);
  const auth = key ? { Authorization: `Bearer ${key}` } : {};
  const sameOrigin = u => u.origin === base.origin;
  const call = async (route, body) => {
    const r = await fetch(new URL(route, base), {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { ...auth, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = await limited(r, 4 * 1024 * 1024).then(b => JSON.parse(b)).catch(() => null);
    if (r.status === 401 || r.status === 403) throw new Said('Key 无效或已过期。');
    if (!r.ok || !j) throw new Said(`MinerU 拒绝了请求：${String(j?.error?.message || `HTTP ${r.status}`).slice(0, 160)}`);
    return j;
  };
  progress('上传中');
  const up = await call('v1/uploads', { filename: name, bytes: pdf.length, mime_type: 'application/pdf', purpose: 'parse', sha256sum: sha256 });
  let file = up.status === 'completed' ? up.file : null;
  if (!file) {
    if (!up.id || !up.upload_url) throw new Said('MinerU 没有返回上传地址。');
    const to = checked(up.upload_url, base);
    const put = await fetch(to, {
      method: up.upload_method || 'PUT', body: pdf, redirect: 'error', signal: AbortSignal.timeout(300000),
      headers: { ...(up.upload_headers || {}), ...(sameOrigin(to) ? auth : {}) },
    });
    if (!put.ok) throw new Said(`上传失败（HTTP ${put.status}）。`);
    file = (await call(`v1/uploads/${encodeURIComponent(up.id)}/complete`, { sha256sum: sha256 })).file;
  }
  if (!file?.id) throw new Said('MinerU 没有确认上传。');
  let job = await call('v1/parse/jobs', { files: [{ source: { type: 'file_id', file_id: file.id } }], output_formats: ['zip'] });
  if (!job.job_id) throw new Said('MinerU 没有返回任务。');
  const id = job.job_id;
  while (!['completed', 'partial', 'failed', 'canceled'].includes(job.status)) {
    if (Date.now() > deadline) throw new Said('识别超过 15 分钟，已放弃；稍后可再试。');
    progress(job.status === 'running' ? '识别中' : '排队中');
    await new Promise(r => setTimeout(r, poll));
    job = await call(`v1/parse/jobs/${encodeURIComponent(id)}`);
  }
  const f = job.files?.[0];
  const zip = f?.output_files?.zip?.file_id;
  if (job.status !== 'completed' || f?.status !== 'completed' || !zip) {
    const why = f?.error?.message || f?.errors?.[0]?.message || job.error?.message || job.status;
    throw new Said(`MinerU 识别失败：${String(why).slice(0, 160)}`);
  }
  progress('下载结果');
  let at = checked(`v1/files/${encodeURIComponent(zip)}/content`, base);
  for (let hops = 0; hops < 3; hops++) {
    const res = await fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(300000), headers: sameOrigin(at) ? auth : {} });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      at = checked(res.headers.get('location'), at);
      continue;
    }
    if (!res.ok) throw new Said(`下载结果失败（HTTP ${res.status}）。`);
    return limited(res, MAX_ZIP);
  }
  throw new Said('下载结果时跳转过多。');
}

export class Recognition {
  // root: Application Support folder; secrets: Secrets; settings(): the preferences (recognition: { auto, selfUrl, fallback }).
  constructor({ root, secrets, settings, fetch = globalThis.fetch, poll = 3000 }) {
    Object.assign(this, { root, secrets, settings, fetch, poll });
    this.jobs = new Map();     // doc.id → { state: 'queued' | 'running' | 'failed', stage?, error?, backend? }
    this.indexes = new Map();  // doc.id → index (or null when there is none on disk)
    this.queue = Promise.resolve();
  }

  dir(doc) {
    return join(this.root, 'recognition', doc.id);
  }

  // The stored result, or null. Cached; a finished job fills it. An index from an older version of the plugin
  // is built again from the kept ZIP: nothing is sent to MinerU again.
  async load(doc) {
    if (!this.indexes.has(doc.id)) {
      const file = join(this.dir(doc), 'index.json');
      let idx = await jsonFile(file, null).catch(() => null);
      if (idx && idx.version !== INDEX_VERSION && idx.pages?.length === doc.pageCount) {
        idx = await this.indexOf(doc, join(this.dir(doc), 'mineru.zip'), idx).catch(() => null);
        if (idx) await atomicJSON(file, idx).catch(() => {});
      }
      this.indexes.set(doc.id, idx?.version === INDEX_VERSION && idx.pages?.length === doc.pageCount ? idx : null);
    }
    return this.indexes.get(doc.id);
  }

  // The blocks of one page, for the reader's jumps and its debug view; null when the paper isn't recognized.
  async page(doc, k) {
    return (await this.load(doc))?.pages[k - 1]?.blocks ?? null;
  }

  // → { state: 'none' | 'queued' | 'running' | 'done' | 'failed', ... } for the status icon and the tools.
  async status(doc) {
    const idx = await this.load(doc);
    if (idx) return { state: 'done', backend: idx.backend, date: idx.date };
    return this.jobs.get(doc.id) || { state: 'none' };
  }

  // Which backends would run, in order: [{ backend, api, key }]. Empty when nothing is set up. The self-hosted
  // service may run without a key; its address is the service root (https://mineru.example.org, not …/v1).
  async backends() {
    const r = (await this.settings()).recognition || {};
    const official = await this.secrets.get('mineru');
    const list = [];
    if (r.selfUrl) list.push({ backend: 'self', api: selfApi(r.selfUrl), key: await this.secrets.get('mineru-self') });
    if (official && (!r.selfUrl || r.fallback)) list.push({ backend: 'official', api: OFFICIAL_API, key: official });
    return list;
  }

  async ready() {
    return (await this.backends()).length > 0;
  }

  // Checks a backend without sending anything: asks for a job that doesn't exist, which a service answers with 404
  // when it accepts the key and 401 when not. key / url: what the user is typing, else what is saved.
  // → { ok, message }.
  async test({ backend, key, url }) {
    const self = backend === 'self';
    if (self) url = String(url ?? (await this.settings()).recognition?.selfUrl ?? '').trim();
    key = String(key ?? (await this.secrets.get(self ? 'mineru-self' : 'mineru'))).trim();
    if (self && !url) return { ok: false, message: '还没有填写自部署 MinerU 的地址。' };
    if (!self && !key) return { ok: false, message: '还没有填写 MinerU Key。' };
    try {
      const at = checked(`v1/parse/jobs/codex-zotero-test-${Date.now()}`, self ? selfApi(url) : OFFICIAL_API);
      const r = await this.fetch(at, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: key ? { Authorization: `Bearer ${key}` } : {} });
      await r.arrayBuffer().catch(() => {});
      if (r.status === 404) return { ok: true, message: key ? '连接正常，Key 有效。' : '连接正常，服务不需要 Key。' };
      if (r.status === 401 || r.status === 403) return { ok: false, message: key ? 'Key 无效或已过期。' : '这个服务需要 Key。' };
      return { ok: false, message: `服务没有正常响应（HTTP ${r.status}）。` };
    } catch (e) {
      const bad = e instanceof Said || e?.code === 'ERR_INVALID_URL';
      return { ok: false, message: bad ? '地址无效：应以 https://（本机服务可用 http://）开头。' : `无法连接：${plainError(e)}` };
    }
  }

  // The stored result once a recognition under way has ended (null when there is none), for the paper map.
  async settled(doc) {
    await this.jobs.get(doc.id)?.done;
    return this.load(doc);
  }

  // Queues the paper unless it is done, queued or running. Jobs run one at a time.
  async start(doc) {
    const busy = () => ['queued', 'running'].includes(this.jobs.get(doc.id)?.state);
    if (busy()) return this.jobs.get(doc.id);
    const now = await this.status(doc);
    if (now.state === 'done') return now;
    if (!(await this.ready())) throw new Error('还没有设置 MinerU 的 Key（或自部署服务）：在阅读器设置的"增强识别"里填写。');
    if (doc.pageCount > MAX_PAGES) throw new Error(`MinerU 每次最多识别 ${MAX_PAGES} 页，这篇有 ${doc.pageCount} 页。`);
    // Checked again after the awaits: two clicks must not start two paid recognitions.
    if (busy()) return this.jobs.get(doc.id);
    const job = { state: 'queued' };
    this.jobs.set(doc.id, job);
    this.queue = this.queue.then(() => this.run(doc, job));
    Object.defineProperty(job, 'done', { value: this.queue }); // not listed: the job is also the status shown
    return job;
  }

  async run(doc, job) {
    job.state = 'running';
    const tried = [];
    try {
      const pdf = await readFile(doc.path);
      if (pdf.length > MAX_PDF) throw new Error('PDF 超过 MinerU 的 200 MB 上限。');
      let zip = null, used = null;
      for (const b of await this.backends()) {
        job.backend = b.backend;
        try {
          zip = await recognizeV1({ ...b, pdf, sha256: doc.fingerprint, name: `${doc.id}.pdf`, fetch: this.fetch, poll: this.poll, progress: s => { job.stage = s; }, deadline: Date.now() + TIMEOUT_MS });
          used = b.backend;
          break;
        } catch (e) {
          tried.push(`${b.backend === 'self' ? '自部署 MinerU' : 'MinerU 官方'}：${plainError(e)}`);
        }
      }
      if (!zip) throw new Error(tried.join('；') || '没有可用的识别后端。');
      await this.save(doc, zip, used);
      this.jobs.delete(doc.id);
    } catch (e) {
      Object.assign(job, { state: 'failed', error: e.message, stage: undefined });
    }
  }

  // Keeps the ZIP (without MinerU's copy of the PDF) and writes the index the tools read.
  async save(doc, zip, backend) {
    const dir = this.dir(doc);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `incoming-${process.pid}.zip`);
    await writeFile(tmp, zip, { mode: 0o600 });
    try {
      await run('/usr/bin/zip', ['-q', '-d', tmp, '*_origin.pdf']).catch(e => {
        if (e.code !== 12) throw e; // 12: nothing matched — no copy of the PDF in this ZIP
      });
      const index = await this.indexOf(doc, tmp, { backend, date: new Date().toISOString().slice(0, 10) });
      await rename(tmp, join(dir, 'mineru.zip'));
      await atomicJSON(join(dir, 'index.json'), index);
      this.indexes.set(doc.id, index);
      return index;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  // The index of a MinerU ZIP. The official ZIP has content_list.json, a self-hosted one structured_content.json.
  async indexOf(doc, zipFile, { backend, date }) {
    const names = (await run('/usr/bin/unzip', ['-Z1', zipFile])).toString().split('\n');
    const read = async n => JSON.parse((await run('/usr/bin/unzip', ['-p', zipFile, n])).toString('utf8'));
    const listName = names.find(n => /(^|\/)[^/]*content_list\.json$/.test(n));
    const structuredName = names.find(n => /(^|\/)structured_content\.json$/.test(n));
    if (!listName && !structuredName) throw new Error('结果里没有 content_list.json 或 structured_content.json。');
    const list = listName ? await read(listName) : fromStructured(await read(structuredName));
    const pages = buildIndex(list, doc.pages);
    if (!pages.some(p => p.text.trim())) throw new Error('MinerU 的结果里没有文字。');
    return { version: INDEX_VERSION, backend, model: 'vlm', date, fingerprint: doc.fingerprint, pageCount: doc.pageCount, pages };
  }
}

// Text of an equation found by its number, for page_image, paper_outline and the paper map:
// [{ page, label, latex, rect, y, x }] — y, x (top, centre) as in the structure index, where links point.
export function equations(index) {
  const out = [];
  index.pages.forEach((p, i) => {
    for (const b of p.blocks) {
      for (const label of (b.type === 'equation' && b.labels) || []) {
        const at = b.rect ? { y: Math.round(b.rect[1]), x: Math.round(b.rect[0] + b.rect[2] / 2) } : {};
        out.push({ page: i + 1, label, latex: b.latex, rect: b.rect, ...at });
      }
    }
  });
  return out;
}

// The structure index with what recognition found: its numbered equations (the layout guess misses some), and its
// figures, tables and algorithms — boxes of the whole thing, not just the caption line; the layout guess keeps the
// ones recognition didn't number.
export function withRecognized(outline, index) {
  if (!index) return outline;
  const found = recognizedCaptions(index);
  const has = new Set(found.map(c => c.kind + c.label));
  const captions = [...found, ...outline.captions.filter(c => !has.has(c.kind + c.label))].sort((a, b) => a.page - b.page || a.y - b.y);
  return { ...outline, equations: equations(index), captions };
}
