// Zotero notes for the notes tab and the model. Note HTML is untrusted (plugins and other apps write it):
// it is sanitized to a small set of tags, formulas are typeset with KaTeX (as Zotero's own note editor does;
// the panel carries KaTeX's fonts), embedded images are inlined as data: URLs, headings get ids for the
// table of contents, and page references become small page tags.
import sanitizeHtml from 'sanitize-html';
import katex from 'katex';
import { localApi, validKey, zoteroFetch } from './zotero.mjs';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const SAFE = {
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 's',
    'sub', 'sup', 'span', 'div', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img'],
  allowedAttributes: {
    a: ['href'], img: ['data-attachment-key', 'alt', 'width', 'height'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
    span: ['class', 'data-annotation', 'data-citation'], pre: ['class'], ol: ['start'],
  },
  allowedClasses: { span: ['math', 'highlight', 'citation', 'underline'], pre: ['math'] },
  allowedSchemes: ['http', 'https', 'zotero'], // zotero://open-pdf links from maps jump within the reader
  allowProtocolRelative: false,
};

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripTags = s => decode(s.replace(/<[^>]*>/g, ''));

function tex(src, displayMode) {
  const body = decode(src).trim().replace(/^\$\$?|\$\$?$/g, '').trim();
  try {
    return katex.renderToString(body, { displayMode, throwOnError: false, trust: false, strict: 'ignore', output: 'html' });
  } catch {
    return `<code>${escape(body)}</code>`;
  }
}

export function noteTitle(html) {
  const h = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  const text = stripTags(h ? h[1] : html.replace(/<\/(p|div|li|tr)>/gi, '\n')).trim().split('\n')[0] || '笔记';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// { html, toc: [{ level, text, id }] } ready to insert into the panel.
export async function renderNote(raw, { loadImage = imageData } = {}) {
  let html = sanitizeHtml(raw, SAFE);
  html = html
    .replace(/<pre class="math">([\s\S]*?)<\/pre>/g, (_, s) => tex(s, true))
    .replace(/<span class="math">([\s\S]*?)<\/span>/g, (_, s) => tex(s, false));
  // Page references in maps and reading notes, "[p.3]" or "[p.4–5, p.9]" around links, read as small page tags here;
  // the note in Zotero keeps its text.
  html = html.replace(/\[((?:<a href="zotero:\/\/open-pdf[^"]*">[^<]*<\/a>|[\s,，、;；])+)\]/g,
    (_, inner) => `<span class="pages">${inner.match(/<a [^>]*>[^<]*<\/a>/g).join('')}</span>`);
  // The first line of a note Codex wrote (map, reading note) says who made it; it reads as a quiet line.
  html = html.replace(/(<\/h1>\s*)<p>((?:AI 生成的论文地图|Codex 根据)[\s\S]*?)<\/p>/, '$1<p class="meta">$2</p>');
  const toc = [];
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    const id = `h-${toc.length}`;
    toc.push({ level: Number(level), text: stripTags(inner).trim(), id });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  const keys = [...new Set([...html.matchAll(/data-attachment-key="([A-Z0-9]{8})"/g)].map(m => m[1]))];
  const images = new Map(await Promise.all(keys.map(async k => [k, await loadImage(k).catch(() => null)])));
  html = html.replace(/<img([^>]*?)data-attachment-key="([A-Z0-9]{8})"([^>]*)>/g, (_, a, k, b) =>
    (images.get(k) ? `<img${a}src="${images.get(k)}" data-attachment-key="${k}"${b}>` : '<span class="missing">［图片未能载入］</span>'));
  return { html, toc };
}

async function imageData(key) {
  const r = await zoteroFetch(`users/0/items/${key}/file`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = (r.headers.get('Content-Type') || 'image/png').split(';')[0];
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(type)) throw new Error('not an image');
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('too large');
  // SVG could carry script; it is shown through <img>, which never runs it.
  return `data:${type};base64,${bytes.toString('base64')}`;
}

// Plain text for the model: headings as "## ", table cells separated by " | ", formulas kept as TeX.
export function noteText(raw) {
  const html = sanitizeHtml(raw, SAFE).replace(/>\s+</g, '><');
  return decode(html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, l, s) => `\n\n${'#'.repeat(Number(l))} ${stripTags(s).trim()}\n`)
    .replace(/<pre class="math">([\s\S]*?)<\/pre>/g, (_, s) => `\n$$${decode(s).replace(/^\$\$?|\$\$?$/g, '')}$$\n`)
    .replace(/<(td|th)[^>]*>/g, ' | ')
    .replace(/<\/tr>/g, '\n')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|div|blockquote|pre|table|ul|ol)>/g, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The section under the first heading containing `heading` (up to the next heading of the same or higher level).
export function noteSection(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^#+ /.test(l) && l.toLowerCase().includes(heading.toLowerCase()));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)[0].length <= level);
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

export async function childNotes(itemKey, read = localApi) {
  if (!validKey(itemKey)) return [];
  const notes = await read(`items/${itemKey}/children?itemType=note`);
  return notes.map(n => ({ key: n.key, title: noteTitle(n.data.note || ''), modified: n.data.dateModified || '' }));
}

export async function getNote(key, read = localApi) {
  if (!validKey(key)) throw new Error('笔记 key 无效。');
  const item = await read(`items/${key}`);
  if (item.data.itemType !== 'note') throw new Error('这个条目不是笔记。');
  return { key, parentItem: item.data.parentItem || null, html: item.data.note || '', title: noteTitle(item.data.note || '') };
}

// A highlight quoted in a note (data-annotation) → the attachment and the place it came from.
export function annotationRef(encoded) {
  let data;
  try {
    data = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
  const attachmentKey = String(data.attachmentURI || '').split('/').pop();
  const pos = data.position || {};
  if (!validKey(attachmentKey) || !Number.isInteger(pos.pageIndex)) return null;
  return { attachmentKey, annotationKey: data.annotationKey || null, pageIndex: pos.pageIndex, rects: pos.rects || [] };
}
