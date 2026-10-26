// The paper map: generated only when the user asks, by the Codex CLI with gpt-6.1-sol,
// from the structure index and the full text — the enhanced recognition's when the paper has one (formulas as
// LaTeX, tables by rows, two columns in reading order), else the repaired glyph text. It is stored as a Zotero child
// note of the paper ("论文地图", tag 论文地图), whose first line says it is AI-made, by which model, when,
// for which PDF (fingerprint) and whether it was checked. The Codex session is kept (no --ephemeral).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAP_PROMPT } from './map-prompt.mjs';
import { childNotes, getNote, noteText } from './notes.mjs';
import { buildOutline, outlineText } from './outline.mjs';
import { withRecognized } from './recognition.mjs';

export const MAP_TAG = '论文地图';
export const MAP_MODEL = process.env.CODEX_ZOTERO_MAP_MODEL || 'gpt-6.1-sol';
export const MAP_EFFORTS = ['low', 'medium', 'high'];
export const MAP_EFFORT = 'medium'; // S8: enough for a map, about 1–1.5 minutes per paper
const CODEX = process.env.CODEX_ZOTERO_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const TIMEOUT_MS = 15 * 60 * 1000;
const SECTIONS = ['一句话', '问题与贡献', '结构', '核心概念与符号', '方法要点', '主要结果', '假设、局限与未来工作'];

// ---------- Markdown → Zotero note HTML ----------

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- links back into the PDF ----------
// Page references ([p.7], [p.3–4, p.9]) and references to equations, figures, tables and algorithms become
// zotero://open-pdf links: Zotero opens its own reader at that page; this reader jumps to the place, using
// the y position (and kind) found in the structure index — extra query parameters Zotero ignores.

const PAGE_GROUP = /\[(p\.[^\]\n]{1,80})\]/g;
const PAGE_TOKEN = /(p\.\s*)?(\d{1,4})(\s*[–—-]\s*\d{1,4})?/g;
const REFS = [
  { kind: 'eq', re: /(式|公式|Eqs?\.|Equations?)\s*[（(]\s*(\d{1,3}[a-z]?)((?:\s*[–—~、,，-]\s*[（(]?\d{0,3}[a-z]?[)）]?)*)\s*[)）]/g },
  { kind: 'fig', re: /(图|Figs?\.|Figures?)\s*(\d{1,3})(?![\d.])/g },
  { kind: 'tab', re: /(表|Tables?|Tab\.)\s*(\d{1,3})(?![\d.])/g },
  { kind: 'alg', re: /(算法|Algorithms?|Alg\.)\s*(\d{1,3})(?![\d.])/g },
];
const CAPTION_KIND = { fig: '图', tab: '表', alg: '算法' };

export const pdfLink = (attachmentKey, page, at) =>
  `zotero://open-pdf/library/items/${attachmentKey}?page=${page}${at ? `&y=${Math.round(at.y)}${at.x != null ? `&x=${Math.round(at.x)}` : ''}&k=${at.kind}` : ''}`;

// refs: { attachmentKey, pageCount, outline } of the paper the note is about.
function linkRefs(escaped, refs, keep) {
  if (!refs?.attachmentKey) return escaped;
  const a = (href, text) => keep(`<a href="${escape(href)}">${text}</a>`);
  let s = escaped.replace(PAGE_GROUP, (_, inner) => `[${inner.replace(PAGE_TOKEN, (m, _p, n) => {
    const page = Number(n);
    return page >= 1 && page <= refs.pageCount ? a(pdfLink(refs.attachmentKey, page), m) : m;
  })}]`);
  for (const { kind, re } of REFS) {
    s = s.replace(re, (m, _w, label) => {
      const hit = kind === 'eq'
        ? refs.outline?.equations.find(e => e.label === label)
        : refs.outline?.captions.find(c => c.kind === CAPTION_KIND[kind] && c.label === label);
      return hit ? a(pdfLink(refs.attachmentKey, hit.page, { y: hit.y, x: hit.x, kind }), m) : m;
    });
  }
  return s;
}

// Inline: formulas become Zotero math nodes (the reader and Zotero both render them), then `code`, [text](url)
// links (http, https, zotero), page and equation links, **bold**, *italic*.
function inline(text, refs) {
  const slots = [];
  const keep = html => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text.replace(/\$\$([^$]+)\$\$|\$([^$\n]+)\$/g, (m, d, i) => keep(d !== undefined ? `<span class="math">$${escape(d.trim())}$</span>` : `<span class="math">$${escape(i)}$</span>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${escape(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?|zotero):\/\/[^\s)]+)\)/g, (_, t, u) => keep(`<a href="${escape(u)}">${escape(t)}</a>`));
  s = linkRefs(escape(s), refs, keep)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
}

// Table cells, split on | but not inside $…$ formulas or at \| (a norm or an escaped bar).
function cells(line) {
  const row = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cell = '', math = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      cell += math ? '\\|' : '|';
      i++;
    } else if (ch === '$') {
      math = !math;
      cell += ch;
    } else if (ch === '|' && !math) {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

export function markdownToNote(md, refs = null) {
  const inline_ = t => inline(t, refs);
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline_).join(' ')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline_(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let m;
    if (/^\s*\$\$/.test(line)) { // display math, possibly over several lines
      flushPara();
      flushList();
      let tex = line.trim().slice(2);
      while (!tex.trimEnd().endsWith('$$') && n + 1 < lines.length) tex += `\n${lines[++n]}`;
      out.push(`<pre class="math">$$${escape(tex.trimEnd().replace(/\$\$$/, '').trim())}$$</pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(line)) { // table
      flushPara();
      flushList();
      const rows = [];
      while (n < lines.length && /^\s*\|.*\|\s*$/.test(lines[n])) rows.push(lines[n++]);
      n--;
      const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      out.push(`<table><tr>${cells(head).map(c => `<th>${inline_(c)}</th>`).join('')}</tr>${rest.map(r => `<tr>${cells(r).map(c => `<td>${inline_(c)}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      flushList();
      const level = Math.min(6, Math.max(2, m[1].length));
      out.push(`<h${level}>${inline_(m[2].trim())}</h${level}>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/))) {
      flushPara();
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[1]);
    } else if (!line.trim()) {
      flushPara();
      // a blank line inside a numbered list does not end it (models space their steps out)
      if (list && !/^\s*(\d{1,3}[.)]|[-*+])\s/.test(lines[n + 1] || '')) flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // continuation of a list item
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

export function mapNoteHTML(md, { title, model, date, fingerprint, refs = null }) {
  const head = `<p>AI 生成的论文地图 · 模型 ${escape(model)} · ${date} · PDF 指纹 ${fingerprint} · 状态：未核验。地图只用于导航，引用请核对原文页码。</p>`;
  return `<div data-schema-version="9"><h1>${MAP_TAG}：${escape(title)}</h1>\n${head}\n${markdownToNote(md, refs)}</div>`;
}

// What the note's first line says about the map.
export function mapInfo(html) {
  const text = noteText(html);
  return {
    model: (text.match(/模型 ([^\s·]+)/) || [])[1] || '',
    date: (text.match(/· (\d{4}-\d{2}-\d{2}) ·/) || [])[1] || '',
    fingerprint: (text.match(/PDF 指纹 ([0-9a-f]{12})/) || [])[1] || '',
    status: (text.match(/状态：([^。\s]+)/) || [])[1] || '',
  };
}

const isMapNote = n => n.title.startsWith(MAP_TAG);

// ---------- generation ----------

// Runs `codex exec` with the prompt and material on stdin; resolves to { text, threadId }.
export function runCodex(input, { model = MAP_MODEL, effort = MAP_EFFORT, codex = CODEX, timeout = TIMEOUT_MS } = {}) {
  return new Promise(async (resolve, reject) => {
    let dir;
    try {
      dir = await mkdtemp(join(tmpdir(), 'codex-zotero-map-'));
    } catch (e) {
      return reject(e);
    }
    const out = join(dir, 'map.md');
    if (!MAP_EFFORTS.includes(effort)) return reject(new Error(`未知的推理强度：${effort}`));
    const args = ['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-s', 'read-only', '--skip-git-repo-check', '-C', dir, '-o', out, '--json', '-'];
    let proc;
    try {
      proc = spawn(codex, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`无法启动 Codex CLI：${e.message}`));
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), timeout);
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', e => { clearTimeout(timer); reject(new Error(`无法启动 Codex CLI：${e.message}`)); });
    proc.on('close', async code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`Codex CLI 退出码 ${code}：${(stderr || stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
        const text = (await readFile(out, 'utf8')).trim();
        resolve({ text, threadId: (stdout.match(/"thread_id":"([^"]+)"/) || [])[1] || null });
      } catch (e) {
        reject(e.code === 'ENOENT' ? new Error('Codex 没有输出地图。') : e);
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

export class PaperMaps {
  // writer: the annotation Writer (authorization and conditional writes); paper, pool: for text and structure.
  // settings(): the user's preferences — mapPrompt / mapModel / mapEffort override the defaults when not empty.
  // recognition: enhanced recognition (status, settled); a recognition under way is waited for.
  constructor({ writer, paper, pool, recognition = null, run = runCodex, now = () => new Date(), settings = async () => ({}) }) {
    Object.assign(this, { writer, paper, pool, recognition, run, now, settings });
    this.jobs = new Map(); // doc id → { status: 'running'|'failed'|'done', stage, error, startedAt, noteKey, threadId }
  }

  async find(doc) {
    if (!doc.itemKey) return null;
    const note = (await childNotes(doc.itemKey)).find(isMapNote);
    if (!note) return null;
    const n = await getNote(note.key);
    return { key: note.key, html: n.html, ...mapInfo(n.html) };
  }

  status(doc) {
    const job = this.jobs.get(doc.id);
    return job ? { status: job.status, ...(job.stage ? { stage: job.stage } : {}), error: job.error || '', startedAt: job.startedAt, noteKey: job.noteKey || null } : { status: 'idle' };
  }

  // idx: the enhanced-recognition index, or null.
  async material(doc, idx = null) {
    const outline = withRecognized(await buildOutline(doc, { pool: this.pool, paper: this.paper }), idx);
    const pages = [];
    let recognized = 0;
    for (let k = 1; k <= doc.pageCount; k++) {
      const { text, source } = await this.paper.pageText(doc, k, idx);
      if (source) recognized++;
      pages.push(`=== 第 ${k} 页 ===\n${text}`);
    }
    const about = recognized ? '来自增强识别：公式为 LaTeX，表格按行列出，双栏按阅读顺序' : '文字已修复；公式与表格可能残缺';
    return `【结构索引（程序生成）】\n${outlineText(doc, outline)}\n\n【全文（逐页，${about}）】\n${pages.join('\n\n')}`;
  }

  // The recognition result to build the map on: waits for one under way (the map is better for it).
  async recognized(doc, job) {
    if (!this.recognition) return null;
    if (['queued', 'running'].includes((await this.recognition.status(doc)).state)) job.stage = '等待增强识别完成';
    try {
      return await this.recognition.settled(doc);
    } catch {
      return null;
    } finally {
      delete job.stage;
    }
  }

  // Starts generating (or regenerating) the map in the background; returns at once.
  start(doc) {
    if (!doc.itemKey) throw new Error('这篇 PDF 不是从 Zotero 打开的，地图无处保存。');
    const running = this.jobs.get(doc.id);
    if (running?.status === 'running') return this.status(doc);
    const job = { status: 'running', startedAt: Date.now() };
    this.jobs.set(doc.id, job);
    job.done = this.generate(doc, job).catch(e => {
      job.status = 'failed';
      job.error = e.message;
    });
    return this.status(doc);
  }

  async generate(doc, job) {
    const idx = await this.recognized(doc, job);
    const prefs = await this.settings();
    const model = prefs.mapModel || MAP_MODEL;
    const { text, threadId } = await this.run(`${prefs.mapPrompt?.trim() || MAP_PROMPT}\n\n${await this.material(doc, idx)}`, { model, effort: prefs.mapEffort || MAP_EFFORT });
    const found = SECTIONS.filter(s => text.includes(`## ${s}`)).length;
    // With the default prompt the output must have its sections; a custom prompt may shape it differently.
    if (text.length < 200 || (!prefs.mapPrompt?.trim() && found < 4)) throw new Error('模型的输出不像一份论文地图，没有写入 Zotero。');
    const date = this.now().toISOString().slice(0, 10);
    const outline = withRecognized(await buildOutline(doc, { pool: this.pool, paper: this.paper }), idx);
    const refs = doc.attachmentKey ? { attachmentKey: doc.attachmentKey, pageCount: doc.pageCount, outline } : null;
    const html = mapNoteHTML(text, { title: doc.title, model, date, fingerprint: doc.fingerprint.slice(0, 12), refs });
    const existing = await this.find(doc);
    job.noteKey = await this.writer.writeNote({ parentItem: doc.itemKey, key: existing?.key, html, tags: [{ tag: MAP_TAG }] });
    job.threadId = threadId;
    job.status = 'done';
  }

  // The map as text for the model, with a warning when it was made for another version of the PDF.
  async read(doc) {
    const map = await this.find(doc);
    if (!map) return null;
    const stale = map.fingerprint && map.fingerprint !== doc.fingerprint.slice(0, 12);
    return { ...map, stale, text: noteText(map.html) };
  }
}
