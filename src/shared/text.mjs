// Selection over a page's glyphs ({ t: [...], b: flat rects, l: line numbers }, see src/server/textlayer.mjs).
// Pure functions so they run in the panel and in unit tests alike. Coordinates are page points, top-left.

export const box = (page, i) => {
  const b = page.b;
  return b[i * 4 + 2] > 0 && b[i * 4 + 3] > 0 ? [b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]] : null;
};

// Lines as { line, y0, y1, glyphs: [index...] } sorted top to bottom; built once per page.
export function linesOf(page) {
  const byLine = new Map();
  page.t.forEach((_, i) => {
    const r = box(page, i);
    if (!r) return;
    const key = page.l[i] >= 0 ? page.l[i] : `y${Math.round(r[1])}`;
    let L = byLine.get(key);
    if (!L) byLine.set(key, (L = { line: key, y0: r[1], y1: r[1] + r[3], glyphs: [] }));
    L.y0 = Math.min(L.y0, r[1]);
    L.y1 = Math.max(L.y1, r[1] + r[3]);
    L.glyphs.push(i);
  });
  return [...byLine.values()].sort((a, b) => a.y0 - b.y0);
}

// The glyph under a point, or the nearest one on the nearest line (so drags past a line's end still work).
export function hitGlyph(page, lines, x, y) {
  let best = null, bestD = Infinity;
  for (const L of lines) {
    const d = y < L.y0 ? L.y0 - y : y > L.y1 ? y - L.y1 : 0;
    // Prefer lines that overlap horizontally with the point (two-column layouts).
    const xs = L.glyphs.map(i => box(page, i));
    const x0 = Math.min(...xs.map(r => r[0])), x1 = Math.max(...xs.map(r => r[0] + r[2]));
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const score = d + dx * 0.25;
    if (score < bestD) { best = L; bestD = score; }
  }
  if (!best) return -1;
  let gi = -1, gd = Infinity;
  for (const i of best.glyphs) {
    const r = box(page, i);
    const d = x < r[0] ? r[0] - x : x > r[0] + r[2] ? x - r[0] - r[2] : 0;
    if (d < gd) { gi = i; gd = d; }
  }
  return gi;
}

const wordChar = t => /[\p{L}\p{N}\p{M}_'’\-]/u.test(t) || /[\u{1D400}-\u{1D7FF}]/u.test(t);

// Double click: the run of word characters around a glyph (stays within one line).
export function wordAt(page, i) {
  if (i < 0 || !wordChar(page.t[i])) return [i, i];
  let a = i, z = i;
  while (a > 0 && page.l[a - 1] === page.l[i] && wordChar(page.t[a - 1])) a--;
  while (z < page.t.length - 1 && page.l[z + 1] === page.l[i] && wordChar(page.t[z + 1])) z++;
  return [a, z];
}

// Triple click: every glyph of the line.
export function lineAt(page, i) {
  const line = page.l[i];
  if (i < 0 || line < 0) return [i, i];
  let a = i, z = i;
  while (a > 0 && page.l[a - 1] === line) a--;
  while (z < page.t.length - 1 && page.l[z + 1] === line) z++;
  return [a, z];
}

// Triple click: the sentence around a glyph → { a, z, skip }. It runs over the lines of a column and ends at
// . ! ? 。！？ (not at "Fig.", "et al.", "e.g.", initials or decimals) or at a paragraph-sized gap. A sentence
// left open at the foot of a column goes on at the top of the next one: the running header, footer and
// figure captions between them are passed over and listed in skip ([from, to] glyph ranges, not selected).
// opts.height: the page height, to tell running headers and footers from body text.
const TERMINAL = /[.!?。！？]/;
const ABBREV = /(^|[^\p{L}])(figs?|eqs?|refs?|secs?|tabs?|no|nos|vol|pp|cf|vs|al|etc|approx|resp|i\.e|e\.g|\p{L})$/iu;
const MAX_SENTENCE = 2000;

function endsSentence(page, j) {
  const t = page.t[j];
  if (!TERMINAL.test(t)) return false;
  if (/[。！？]/.test(t)) return true;
  const next = page.t[j + 1];
  if (next !== undefined && next !== ' ' && next !== '\n') return false; // 1.5, e.g., URLs
  if (t !== '.') return true;
  let w = '';
  for (let k = j - 1; k >= 0 && k > j - 8 && /[\p{L}.]/u.test(page.t[k]); k--) w = page.t[k] + w;
  return !ABBREV.test(w);
}

const MARGIN = 0.07;
const CAPTION_START = /^(fig\.?|figure|table|tab\.|algorithm|alg\.)\s*\d/i;

export function sentenceAt(page, lines, i, { height = 0 } = {}) {
  if (i < 0) return { a: i, z: i, skip: [] };
  const lineOf = new Map();
  lines.forEach((L, n) => L.glyphs.forEach(g => lineOf.set(g, n)));
  const info = new Map();
  const about = L => {
    if (!info.has(L)) {
      const bs = L.glyphs.map(g => box(page, g));
      info.set(L, { x0: Math.min(...bs.map(r => r[0])), x1: Math.max(...bs.map(r => r[0] + r[2])), text: L.glyphs.map(g => page.t[g]).join('').trim() });
    }
    return info.get(L);
  };
  const lineAtGlyph = j => lines[lineOf.get(j)];
  const xOverlap = (A, B) => Math.min(about(A).x1, about(B).x1) - Math.max(about(A).x0, about(B).x0) > 0;
  // Does reading go on from line A to the line B after it? Yes for the same printed line split by PDFKit
  // (sub/superscripts, inline formulas overlap in height), or for the next line of the same column.
  const together = (a, b) => {
    const A = lineAtGlyph(a), B = lineAtGlyph(b);
    if (!A || !B || A === B) return true;
    if (Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) > 0) return true;
    const h = Math.max(A.y1 - A.y0, B.y1 - B.y0);
    const gap = B.y0 - A.y1;
    if (gap < -h * 0.5 || gap > h * 1.5) return false;
    return xOverlap(A, B); // below and overlapping: the same column, not a sidebar
  };

  // Body text, as opposed to a running header/footer or a caption (judged against the clicked line).
  const home = lineAtGlyph(i);
  const bodyH = home ? home.y1 - home.y0 : 0;
  const isBody = L => {
    if (height && (L.y1 < height * MARGIN || L.y0 > height * (1 - MARGIN))) return false;
    if (CAPTION_START.test(about(L).text)) return false;
    return L.y1 - L.y0 > bodyH * 0.8;
  };
  // Width of the column a line sits in: the extent of the body lines it overlaps. The two columns of one text
  // are about as wide as each other; a keyword list or sidebar is much narrower than the main text.
  const columnWidth = L => {
    const mates = lines.filter(M => M === L || (isBody(M) && xOverlap(M, L)));
    return Math.max(...mates.map(M => about(M).x1)) - Math.min(...mates.map(M => about(M).x0));
  };
  const bodyAbove = L => lines.some(M => M !== L && isBody(M) && M.y1 <= L.y0 + 0.5 && xOverlap(M, L));
  const bodyBelow = L => lines.some(M => M !== L && isBody(M) && M.y0 >= L.y1 - 0.5 && xOverlap(M, L));
  // From the last line of a column (A, at glyph `from`), the first body line of the next column, searching
  // in reading order (dir +1) or, going back from the first line of a column, the last line of the previous one.
  const nextColumn = (A, from, dir) => {
    if (!isBody(A) || (dir > 0 ? bodyBelow(A) : bodyAbove(A))) return -1;
    for (let j = from, n = 0; j >= 0 && j < page.t.length && n < 1500; j += dir, n++) {
      const B = lineAtGlyph(j);
      if (!B || B === A || !box(page, j) || !isBody(B)) continue;
      const beside = dir > 0 ? about(B).x0 > about(A).x0 + (about(A).x1 - about(A).x0) * 0.3 : about(B).x1 < about(A).x1 - (about(A).x1 - about(A).x0) * 0.3;
      const edge = dir > 0 ? !bodyAbove(B) : !bodyBelow(B);
      const wa = columnWidth(A), wb = columnWidth(B);
      return beside && edge && Math.min(wa, wb) > Math.max(wa, wb) * 0.75 ? j : -1;
    }
    return -1;
  };

  const boxed = j => box(page, j) !== null;
  const skip = [];
  let a = i, lastA = i, jumpedA = false;
  while (a > 0 && i - a < MAX_SENTENCE) {
    let j = a - 1;
    // Leaving the column comes first: a period on a caption or header is not this sentence's start.
    if (boxed(j) && !together(j, lastA)) {
      const k = jumpedA ? -1 : nextColumn(lineAtGlyph(lastA), j, -1);
      if (k < 0) break;
      if (k < j) skip.push([k + 1, j]);
      jumpedA = true;
      j = k;
    }
    if (endsSentence(page, j)) break;
    if (boxed(j)) lastA = j;
    a = j;
  }
  while (a < i && /\s/.test(page.t[a])) a++;
  let z = i, lastZ = i, jumpedZ = false;
  while (z < page.t.length - 1 && z - i < MAX_SENTENCE && !endsSentence(page, z)) {
    let j = z + 1;
    if (boxed(j) && !together(lastZ, j)) {
      const k = jumpedZ ? -1 : nextColumn(lineAtGlyph(lastZ), j, 1);
      if (k < 0) break;
      if (k > j) skip.push([j, k - 1]);
      jumpedZ = true;
      j = k;
    }
    if (boxed(j)) lastZ = j;
    z = j;
  }
  while (z > a && /\s/.test(page.t[z])) z--;
  return { a, z, skip: skip.filter(([s, e]) => s >= a && e <= z).sort((x, y) => x[0] - y[0]) };
}

// The glyph ranges a..z minus the skipped ones.
export function rangesOf(a, z, skip = []) {
  const out = [];
  let from = a;
  for (const [s, e] of skip) {
    if (s > from) out.push([from, s - 1]);
    from = Math.max(from, e + 1);
  }
  if (from <= z) out.push([from, z]);
  return out;
}

// Plain text of glyphs a..z: line breaks become spaces, a hyphen at a line end joins the word.
export function textOf(page, a, z) {
  return page.t.slice(a, z + 1).join('')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Highlight boxes for glyphs a..z: one box per line, from its first to its last selected glyph.
export function rectsOf(page, a, z) {
  const byLine = new Map();
  for (let i = a; i <= z; i++) {
    const r = box(page, i);
    if (!r) continue;
    const key = page.l[i] >= 0 ? page.l[i] : `y${Math.round(r[1])}`;
    const u = byLine.get(key);
    byLine.set(key, u ? [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[0] + r[2]), Math.max(u[3], r[1] + r[3])]
      : [r[0], r[1], r[0] + r[2], r[1] + r[3]]);
  }
  return [...byLine.values()].map(u => [u[0], u[1], u[2] - u[0], u[3] - u[1]]);
}

// ---------- search ----------

// A page's text as one searchable string, each character mapped back to its glyph. Lines are joined as in
// textOf. loose keeps only letters and digits, so a quote still matches across spacing, punctuation,
// quote marks and hyphenation (used to find text the model quotes); otherwise whitespace is collapsed.
export function searchable(page, { loose = false } = {}) {
  let s = '';
  const map = [];
  for (let i = 0; i < page.t.length; i++) {
    const t = page.t[i];
    if (t === '\n') {
      if (s.endsWith('-')) {
        s = s.slice(0, -1);
        map.pop();
      } else if (!loose && s && !s.endsWith(' ')) {
        s += ' ';
        map.push(i);
      }
      continue;
    }
    for (const ch of t.toLowerCase()) {
      if (loose ? !/[\p{L}\p{N}]/u.test(ch) : /\s/.test(ch) && (!s || s.endsWith(' '))) continue;
      s += /\s/.test(ch) ? ' ' : ch;
      map.push(i);
      if (ch.length === 2) map.push(i); // a math letter like 𝐪 is two UTF-16 units of s; keep map in step with s
    }
  }
  return { s, map };
}

export const searchKey = (query, { loose = false } = {}) => {
  const q = query.toLowerCase();
  return loose ? [...q].filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('') : q.replace(/\s+/g, ' ').trim();
};

// Every occurrence of query on the page, as glyph ranges [a, z].
export function findAll(page, query, { loose = false, index = searchable(page, { loose }) } = {}) {
  const q = searchKey(query, { loose });
  const out = [];
  if (!q) return out;
  for (let at = index.s.indexOf(q); at >= 0; at = index.s.indexOf(q, at + q.length)) {
    out.push([index.map[at], index.map[at + q.length - 1]]);
  }
  return out;
}

// ---------- the block of text a jump lands on ----------

// What to outline after jumping to (x, y) on a page → [x, y, w, h] or null. kind: 'eq' (a display equation:
// its narrower-than-the-column lines around y), 'fig' (caption at y and the figure above it), 'tab' / 'alg'
// (caption lines), or none (the line there, or the display block if the line is one). The column is the
// extent of the lines near y that contain x, so a single-column figure or equation is not outlined across
// both columns.
const h0 = l => l.y1 - l.y0;
const MAX_EQ_PT = 110; // the tallest display equation outlined (a few aligned lines)

export function targetBlock(page, lines, { x = null, y, kind = null }) {
  const boxes = lines.map(l => l.glyphs.map(g => box(page, g)).filter(Boolean).sort((a, b) => a[0] - b[0]));
  const all = boxes.flat();
  if (!all.length) return null;
  const mid = (Math.min(...all.map(r => r[0])) + Math.max(...all.map(r => r[0] + r[2]))) / 2;
  // PDFKit can join a line of the left column with one of the right column at the same height (an equation
  // number and the text beside it): a line with a gap over the middle of the page is two lines.
  const parts = [];
  lines.forEach((l, k) => {
    let part = null;
    const glyphs = l.glyphs.filter(g => box(page, g)).sort((a, b) => box(page, a)[0] - box(page, b)[0]);
    glyphs.forEach((g, n) => {
      const r = boxes[k][n];
      if (part && r[0] - part.x1 > 6 && part.x1 <= mid + 2 && r[0] >= mid - 2) {
        parts.push(part);
        part = null;
      }
      if (!part) part = { y0: l.y0, y1: l.y1, x0: r[0], x1: r[0] + r[2], last: '' };
      else part.x1 = Math.max(part.x1, r[0] + r[2]);
      if (page.t[g].trim()) part.last = page.t[g];
    });
    if (part) parts.push(part);
  });
  // ...and can split one line of text in two (around a superscript): pieces of the same size side by side at
  // the same height, in the same column, are one line again (not the tall pieces of a formula).
  parts.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const L = [];
  for (const p of parts) {
    const hp = p.y1 - p.y0;
    const q = L.find(o => Math.abs((o.y1 - o.y0) - hp) <= 0.3 * Math.max(o.y1 - o.y0, hp) && Math.min(o.y1, p.y1) - Math.max(o.y0, p.y0) > 0.5 * hp
      && p.x0 - o.x1 < 10 && p.x0 >= o.x0 && (o.x1 <= mid + 2) === (p.x1 <= mid + 2));
    if (q) Object.assign(q, { y0: Math.min(q.y0, p.y0), y1: Math.max(q.y1, p.y1), x1: Math.max(q.x1, p.x1), last: p.last || q.last });
    else L.push({ ...p });
  }
  L.sort((a, b) => a.y0 - b.y0);
  if (!L.length) return null;
  const near = L.filter(l => l.y0 > y - 150 && l.y0 < y + 150);
  const at = l => l.y0 <= y + 3 && l.y1 >= y - 1;
  let seed = x != null ? near.find(l => at(l) && l.x0 - 2 <= x && x <= l.x1 + 2) : null;
  // Without x, lines at that height in two columns leave the target unknown: better no box than the wrong one.
  if (x == null) {
    const level = near.filter(at);
    if (level.some(a => level.some(b => b.x0 > a.x1 + 4))) return null;
  }
  seed ??= near.filter(at).sort((a, b) => (x == null ? 0 : Math.abs((a.x0 + a.x1) / 2 - x) - Math.abs((b.x0 + b.x1) / 2 - x)))[0];
  seed ??= near.find(l => l.y0 >= y && l.y0 < y + 20 && (x == null || (l.x0 - 2 <= x && x <= l.x1 + 2)));
  if (!seed) return null;
  const cx = x ?? (seed.x0 + seed.x1) / 2;
  // When the target sits in one column, lines across the middle (a caption or a wide figure above) don't set the width.
  const side = seed.x1 <= mid + 2 ? -1 : seed.x0 >= mid - 2 ? 1 : 0;
  const holders = near.filter(l => l.x0 - 2 <= cx && cx <= l.x1 + 2 && (side < 0 ? l.x1 <= mid + 2 : side > 0 ? l.x0 >= mid - 2 : true));
  let c0 = Math.min(seed.x0, ...holders.map(l => l.x0)), c1 = Math.max(seed.x1, ...holders.map(l => l.x1));
  // A figure caption centred in the gutter (no other line crosses its middle) belongs to a figure spanning
  // both columns: use the width of the text block.
  if (kind === 'fig' && holders.every(l => Math.abs(l.y0 - seed.y0) < h0(seed) * 3)) {
    c0 = Math.min(...L.map(l => l.x0));
    c1 = Math.max(...L.map(l => l.x1));
  }
  const inCol = l => l.x0 >= c0 - 4 && l.x1 <= c1 + 4;
  const col = L.filter(inCol);
  const h = seed.y1 - seed.y0;
  const full = l => l.x1 - l.x0 >= (c1 - c0) * 0.8;
  const i = col.indexOf(seed);
  let top = seed.y0, bottom = seed.y1;
  if (kind === 'fig' || kind === 'tab' || kind === 'alg') {
    for (let j = i + 1; j < col.length && col[j].y0 - bottom < h * 0.6; j++) bottom = Math.max(bottom, col[j].y1); // caption lines
    if (kind === 'fig') {
      const above = col.slice(0, Math.max(0, i)).filter(l => l.y1 < seed.y0 - 2).at(-1);
      top = above && seed.y0 - above.y1 < 500 ? above.y1 + 2 : Math.max(0, seed.y0 - 200);
    }
  } else if (kind === 'eq' || !full(seed)) {
    // A display equation: its lines are narrower than the column and set apart from the paragraphs. It grows
    // from the numbered line up and down, nearest line first, and stays within a few lines: in an algorithm
    // or a list every line is short, and the whole of it is not the equation.
    if (i >= 0) {
      let up = i - 1, down = i + 1;
      // The sentence leading into it ("…as follows:") starts at the column edge and ends with a colon.
      const leadIn = l => l.x0 <= c0 + 3 && /[:：]/.test(l.last);
      // A paragraph line fills the column and touches its edge (justified text reaches the right one, even when
      // the first line is indented); a wide equation line is indented or centred and stops short of both.
      const prose = l => full(l) && (l.x0 <= c0 + 3 || l.x1 >= c1 - 1.5);
      const fits = l => !prose(l) && !leadIn(l) && Math.max(bottom, l.y1) - Math.min(top, l.y0) <= MAX_EQ_PT;
      for (;;) {
        const u = up >= 0 && fits(col[up]) && top - col[up].y1 < h * 2 ? col[up] : null;
        const d = down < col.length && fits(col[down]) && col[down].y0 - bottom < h * 2 ? col[down] : null;
        if (!u && !d) break;
        if (u && (!d || top - u.y1 <= d.y0 - bottom)) {
          top = u.y0;
          up--;
        } else {
          bottom = d.y1;
          down++;
        }
      }
    }
  }
  return [c0 - 2, top - 2, c1 - c0 + 4, bottom - top + 4];
}
