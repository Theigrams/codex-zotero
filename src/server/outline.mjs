// Structure index of a paper: the PDF's bookmarks, plus section
// headings, figure / table captions and numbered equations found in the text layout. Heuristic by nature;
// it is for finding your way around, so it errs towards leaving things out. Cached per PDF fingerprint.
import { join } from 'node:path';
import { atomicJSON, jsonFile } from './files.mjs';

const VERSION = 2; // 2: x (the line's centre) for captions and equations, to outline the right column
const NAMED = /^(abstract|introduction|related work|background|method(s|ology)?|experiments?|results|discussion|conclusions?|references|acknowledg(e)?ments?|appendix\b.*)$/i;
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\p{Lu}\S.{0,90})$/u;
// A caption has a separator after its number ("Fig. 2. Five-axis…", "Table 1: …"); "Fig. 1(c)) shows" is a reference.
const CAPTION = /^(fig\.?|figure|table|algorithm|alg\.)\s*(\d{1,3}[a-z]?)\s*[.:|]\s+(.*)$|^(algorithm)\s*(\d{1,3})\s+(\p{Lu}.*)$/iu;
// Headings are short phrases: no colon, no sentence break, no math, no "=".
const headingLike = t => !/[:=]|\. \S/.test(t) && !/[\u{1D400}-\u{1D7FF}]/u.test(t) && t.split(' ').length <= 14;
const EQUATION = /\((\d{1,3}[a-z]?)\)\s*$/;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Lines of a page as { text, y, x0, x1 } from the glyph data (line ids from the text layer).
export function pageLines(page) {
  const lines = new Map();
  page.t.forEach((t, i) => {
    if (t === '\n') return;
    const key = page.l[i];
    const [x, y, w, h] = [page.b[i * 4], page.b[i * 4 + 1], page.b[i * 4 + 2], page.b[i * 4 + 3]];
    let L = lines.get(key);
    if (!L) lines.set(key, (L = { text: '', y: Infinity, x0: Infinity, x1: -Infinity }));
    L.text += t;
    if (w > 0 && h > 0) {
      L.y = Math.min(L.y, y);
      L.x0 = Math.min(L.x0, x);
      L.x1 = Math.max(L.x1, x + w);
    }
  });
  return [...lines.values()].filter(L => Number.isFinite(L.y)).map(L => ({ ...L, text: L.text.replace(/\s+/g, ' ').trim() }));
}

export function scanPage(lines, k) {
  const sections = [], captions = [], equations = [];
  for (const L of lines) {
    const t = L.text;
    if (!t) continue;
    let m;
    if ((m = t.match(CAPTION))) {
      const [kind, label, text] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
      captions.push({ kind: /^t/i.test(kind) ? '表' : /^a/i.test(kind) ? '算法' : '图', label, page: k, y: Math.round(L.y), x: Math.round((L.x0 + L.x1) / 2), text: clip(text, 120) });
    } else if (t.length <= 90 && !/[.,;:]$/.test(t) && ((m = t.match(NUMBERED)) || NAMED.test(t))) {
      if (m && (Number(m[1].split('.')[0]) > 20 || !headingLike(m[2]))) continue;
      sections.push({ number: m ? m[1] : '', title: m ? m[2] : t, page: k, y: Math.round(L.y) });
    } else if ((m = t.match(EQUATION)) && t.length < 160 && !/\b(eqs?\.|equations?|in)\s*\(\d/i.test(t)) {
      equations.push({ label: m[1], page: k, y: Math.round(L.y), x: Math.round((L.x0 + L.x1) / 2) });
    }
  }
  return { sections, captions, equations };
}

export async function buildOutline(doc, { pool, paper }) {
  const file = join(doc.cacheDir, `outline-v${VERSION}.json`);
  const cached = await jsonFile(file, null);
  if (cached) return cached;
  const { outline: bookmarks = [] } = await pool.run(doc.path, { op: 'outline' }, 2).catch(() => ({}));
  const out = { bookmarks, sections: [], captions: [], equations: [] };
  const seenEq = new Set();
  const seenCap = new Set();
  let refs = null; // nothing in the reference list is a heading, caption or equation of the paper
  const after = (x, r) => r && (x.page > r.page || (x.page === r.page && x.y > r.y));
  for (let k = 1; k <= doc.pageCount; k++) {
    const found = scanPage(pageLines(await paper.page(doc, k)), k);
    for (const s of found.sections) {
      if (after(s, refs) && !/^appendix/i.test(s.title)) continue;
      out.sections.push(s);
      if (/^references$/i.test(s.title)) refs ??= s;
    }
    for (const c of found.captions) {
      if (after(c, refs) || seenCap.has(c.kind + c.label)) continue;
      seenCap.add(c.kind + c.label);
      out.captions.push(c);
    }
    for (const e of found.equations) {
      if (after(e, refs) || seenEq.has(e.label)) continue; // later lines ending in "(3)" are mostly references back
      seenEq.add(e.label);
      out.equations.push(e);
    }
  }
  await atomicJSON(file, out);
  return out;
}

export function outlineText(doc, o) {
  const parts = [`《${doc.title}》共 ${doc.pageCount} 页。`];
  if (o.bookmarks.length) parts.push(`PDF 书签：\n${o.bookmarks.map(b => `${'  '.repeat(b.depth)}${b.title}${b.page ? `（第 ${b.page} 页）` : ''}`).join('\n')}`);
  // Bookmarks are the author's own structure; inferred headings are only a fallback.
  if (o.sections.length && o.bookmarks.length < 3) parts.push(`章节（按版式推断）：\n${o.sections.map(s => `${s.number ? `${s.number} ` : ''}${s.title}（第 ${s.page} 页）`).join('\n')}`);
  if (o.captions.length) parts.push(`图表：\n${o.captions.map(c => `${c.kind} ${c.label}（第 ${c.page} 页）${c.text}`).join('\n')}`);
  if (o.equations.length) parts.push(`编号公式：${o.equations.map(e => `(${e.label}) 第 ${e.page} 页`).join('；')}`);
  return parts.join('\n\n');
}
