// Guided reading and the reading note. When the user asks to be led through a
// paper, Codex reads it with the user's reading questions and leads them, one step at a time, until every
// question is answered. What was worked out goes into one Zotero child note per paper ("精读笔记"), organised
// as Codex sees fit — the questions are the lens, not the note's outline — and kept up to date: sections are
// replaced or added by title, sections not touched keep their HTML as it is in Zotero (edits the user made
// there, quoted highlights), and the note ends with the reading progress, which question is done.
import { childNotes, getNote, noteText } from './notes.mjs';
import { buildOutline } from './outline.mjs';
import { markdownToNote } from './map.mjs';
import { DEFAULT_QUESTIONS, parseTemplate } from './reading-questions.mjs';

export const NOTE_TAG = '精读笔记';
const PROGRESS = '阅读进度';
const MAX_SECTION = 12000;

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = html => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const isReadingNote = n => n.title.startsWith(NOTE_TAG);
const questionsOf = tpl => tpl.groups.flatMap(g => g.questions);

// Note HTML → { sections: [{ title, heading, html }], done: [question titles] }, split at <h2>. What comes
// before the first <h2> (title, first line) and the progress section are rewritten on every save.
export function splitNote(html) {
  const body = html.replace(/^\s*<div[^>]*>/, '').replace(/<\/div>\s*$/, '');
  const sections = [];
  let current = null, last = 0, done = [];
  const flush = end => {
    if (current) current.html = body.slice(last, end).trim();
  };
  for (const m of body.matchAll(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/g)) {
    flush(m.index);
    last = m.index + m[0].length;
    current = m[1] === '2' ? { title: text(m[2]), heading: m[2].trim(), html: '' } : null;
    if (current) sections.push(current);
  }
  flush(body.length);
  const progress = sections.find(s => s.title === PROGRESS);
  if (progress) {
    const line = text(progress.html.replace(/<\/li>/g, '\n')).match(/已读完：([^\n]*?)(?:未读到：|全部|$)/);
    done = line ? line[1].split(/[；;]/).map(x => x.replace(/^\s*第\s*\d+\s*问\s*/, '').replace(/[。.\s]+$/, '').trim()).filter(Boolean) : [];
  }
  return { sections: sections.filter(s => s !== progress), done };
}

// Headings inside a section sit below its own <h2>.
const sectionHTML = (md, refs) => markdownToNote(md.replace(/^(\s*)#{1,2}\s+/gm, '$1### '), refs);

// The note after applying updates: sections [{ title, content }] (empty content removes the section),
// done: question numbers now worked through.
export function buildNote(tpl, previous, { sections = [], done = [] }, { title, date, refs = null }) {
  const list = (previous?.sections || []).map(s => ({ ...s }));
  for (const u of sections) {
    const heading = markdownToNote(`## ${u.title.trim()}`, refs).replace(/^<h2>|<\/h2>$/g, '');
    const at = list.findIndex(s => s.title === text(heading));
    if (!u.content.trim()) {
      if (at >= 0) list.splice(at, 1);
    } else {
      const next = { title: text(heading), heading, html: sectionHTML(u.content, refs) };
      if (at >= 0) list[at] = next;
      else list.push(next);
    }
  }
  const qs = questionsOf(tpl);
  const doneSet = new Set(qs.filter(q => previous?.done.includes(q.title) || done.includes(q.n)).map(q => q.n));
  const read = qs.filter(q => doneSet.has(q.n)), unread = qs.filter(q => !doneSet.has(q.n));
  const item = q => `第 ${q.n} 问 ${escape(q.title)}`;
  const progress = !qs.length ? '' : `<h2>${PROGRESS}</h2>\n<ul>${read.length ? `<li>已读完：${read.map(item).join('；')}</li>` : ''}`
    + `${unread.length ? `<li>未读到：${unread.map(item).join('；')}</li>` : '<li>全部问题已读完。</li>'}</ul>`;
  const out = [`<h1>${NOTE_TAG}：${escape(title)}</h1>`, `<p>Codex 根据导读对话整理 · 最后整理 ${date} · 引用请核对原文页码。</p>`,
    ...list.map(s => `<h2>${s.heading}</h2>\n${s.html}`), progress].filter(Boolean);
  return { html: `<div data-schema-version="9">${out.join('\n')}</div>`, done: read.map(q => q.n), remaining: unread.map(q => q.n), sections: list.length };
}

// The reading questions as the model reads them: every question in full, marked when already worked through.
export function questionsText(tpl, done = []) {
  const lines = [];
  for (const g of tpl.groups) {
    lines.push(`【${g.title}】${g.note ? ` ${g.note}` : ''}`);
    for (const q of g.questions) lines.push(`第 ${q.n} 问 ${q.title}${done.includes(q.title) ? '（已读完）' : ''}：${q.text}`);
  }
  return lines.join('\n');
}

export class ReadingNotes {
  // writer: the annotation Writer (authorization, note writes); settings(): preferences (readingQuestions).
  constructor({ writer, paper, pool, settings = async () => ({}), now = () => new Date() }) {
    Object.assign(this, { writer, paper, pool, settings, now });
  }

  async questions() {
    return parseTemplate((await this.settings()).readingQuestions?.trim() || DEFAULT_QUESTIONS);
  }

  async find(doc) {
    if (!doc.itemKey) return null;
    const note = (await childNotes(doc.itemKey)).find(isReadingNote);
    if (!note) return null;
    const n = await getNote(note.key);
    const { done } = splitNote(n.html);
    return { key: note.key, html: n.html, done, date: (noteText(n.html).match(/最后整理 (\d{4}-\d{2}-\d{2})/) || [])[1] || '' };
  }

  async read(doc) {
    const tpl = await this.questions();
    const note = await this.find(doc);
    const done = note ? questionsOf(tpl).filter(q => note.done.includes(q.title)) : [];
    return { tpl, note, done: done.map(q => q.title), count: questionsOf(tpl).length, text: note ? noteText(note.html) : null };
  }

  async save(doc, { sections = [], done = [] }) {
    if (!doc.itemKey) throw new Error('这篇 PDF 不是从 Zotero 打开的，笔记无处保存。');
    const tpl = await this.questions();
    const count = questionsOf(tpl).length;
    for (const n of done) if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`没有第 ${n} 问；精读问题共 ${count} 问。`);
    for (const s of sections) {
      if (!s.title.trim()) throw new Error('每一节都需要标题。');
      if (s.content.length > MAX_SECTION) throw new Error(`"${s.title.slice(0, 20)}"一节太长（${s.content.length} 字，上限 ${MAX_SECTION}）。`);
    }
    const note = await this.find(doc);
    const outline = await buildOutline(doc, { pool: this.pool, paper: this.paper });
    const refs = doc.attachmentKey ? { attachmentKey: doc.attachmentKey, pageCount: doc.pageCount, outline } : null;
    const built = buildNote(tpl, note ? splitNote(note.html) : null, { sections, done },
      { title: doc.title, date: this.now().toISOString().slice(0, 10), refs });
    if (!note && !built.sections) throw new Error('没有可写入的内容。');
    const key = await this.writer.writeNote({ parentItem: doc.itemKey, key: note?.key, html: built.html, tags: [{ tag: NOTE_TAG }] });
    return { key, created: !note, ...built };
  }
}
