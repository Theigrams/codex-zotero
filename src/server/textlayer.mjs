// Page text for selection: geometry from PDFKit (it matches what we render), content repaired by MuPDF
// (ligatures, Σ/∑ from embedded glyph names) where PDFKit's text is wrong or missing. See spike S2.

const EXPAND_X = 0.4;     // points of slack around a MuPDF glyph when looking for the PDFKit char inside it
const MIN_Y_OVERLAP = 0.3;

const center = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const yOverlap = (a, b) => Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])) / Math.max(1e-6, Math.min(a[3], b[3]));
const blank = r => !r || r[2] <= 0 || r[3] <= 0;
// Control characters, private use and U+FFFD mean PDFKit could not map the glyph to text.
const unmapped = t => /[\u0000-\u0008\u000e-\u001f-�]/u.test(t);

// pk: { text, rects: flat [x,y,w,h] per UTF-16 unit, lines: [[start, length]] } from the PDFKit helper.
// mu: [{ t, r, src }] from native/text_server.py, or null when MuPDF is unavailable.
// Returns glyphs in reading order: { t, r, line } (line -1 for whitespace between lines).
export function mergeText(pk, mu) {
  const lineOf = new Int32Array(pk.text.length).fill(-1);
  pk.lines.forEach(([start, length], i) => lineOf.fill(i, start, start + length));

  const glyphs = [];
  let offset = 0;
  for (const t of pk.text) {
    const r = pk.rects.slice(offset * 4, offset * 4 + 4);
    glyphs.push({ t, r: blank(r) ? null : r, line: lineOf[offset] });
    offset += t.length;
  }
  if (!mu?.length) return glyphs;

  // Bucket PDFKit glyphs by centre y so each MuPDF glyph only checks its neighbourhood.
  const grid = new Map();
  glyphs.forEach((g, i) => {
    if (!g.r) return;
    const k = Math.floor(center(g.r)[1] / 10);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const used = new Set();
  const inserts = [];
  for (const m of mu) {
    if (!m.t.trim()) continue;
    const r = m.r;
    let best = -1, bestDx = Infinity;
    for (let k = Math.floor(r[1] / 10) - 1; k <= Math.floor((r[1] + r[3]) / 10) + 1; k++) {
      for (const i of grid.get(k) || []) {
        if (used.has(i)) continue;
        const [cx] = center(glyphs[i].r);
        if (cx < r[0] - EXPAND_X || cx > r[0] + r[2] + EXPAND_X || yOverlap(r, glyphs[i].r) < MIN_Y_OVERLAP) continue;
        const dx = Math.abs(cx - (r[0] + r[2] / 2));
        if (dx < bestDx) { best = i; bestDx = dx; }
      }
    }
    if (best >= 0) {
      used.add(best);
      // Trust MuPDF only where it repaired something, or where PDFKit has no usable text.
      if (m.src !== 'unicode' || unmapped(glyphs[best].t)) glyphs[best].t = m.t;
    } else {
      inserts.push(m);
    }
  }

  // Glyphs PDFKit dropped entirely (fi/fl ligatures). PDFKit keeps the text around them, sometimes with a
  // space where the glyph was: "of feed uctuation", "ef cienc". Put each glyph between its left (p) and
  // right (q) neighbours on the line: after the word space if there is a real gap on its left, otherwise
  // straight after p — and if it fills the gap to q as well, the space PDFKit left there is spurious.
  const GAP = 1; // points; a word space is wider
  const after = new Map(); // index → glyphs to insert after it
  const before = new Map();
  const drop = new Set();
  const push = (map, i, g) => (map.get(i) || map.set(i, []).get(i)).push(g);
  for (const m of inserts) {
    const mx = center(m.r)[0];
    let p = -1, q = -1;
    glyphs.forEach((g, i) => {
      if (!g.r || yOverlap(m.r, g.r) < MIN_Y_OVERLAP) return;
      const gx = center(g.r)[0];
      if (gx < mx && (p < 0 || gx > center(glyphs[p].r)[0])) p = i;
      if (gx >= mx && (q < 0 || gx < center(glyphs[q].r)[0])) q = i;
    });
    const glyph = { t: m.t, r: m.r, line: p >= 0 ? glyphs[p].line : q >= 0 ? glyphs[q].line : -1 };
    const gapLeft = p >= 0 ? m.r[0] - (glyphs[p].r[0] + glyphs[p].r[2]) : Infinity;
    const gapRight = q >= 0 ? glyphs[q].r[0] - (m.r[0] + m.r[2]) : Infinity;
    if (p >= 0 && gapLeft <= GAP) {
      push(after, p, glyph);
      if (q > p && gapRight <= GAP) for (let i = p + 1; i < q; i++) if (!glyphs[i].r && /\s/.test(glyphs[i].t)) drop.add(i);
    } else if (q >= 0) {
      push(before, q, glyph);
    } else if (p >= 0) {
      push(after, p, glyph);
    }
  }
  const out = [];
  glyphs.forEach((g, i) => {
    for (const b of (before.get(i) || []).sort((a, c) => a.r[0] - c.r[0])) out.push(b);
    if (!drop.has(i)) out.push(g);
    for (const a of (after.get(i) || []).sort((a, c) => a.r[0] - c.r[0])) out.push(a);
  });
  return out;
}

// Compact wire format for the panel: strings, a flat rect array (0s for no box) and line numbers.
export function packGlyphs(glyphs) {
  const b = new Array(glyphs.length * 4);
  glyphs.forEach((g, i) => {
    const r = g.r || [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) b[i * 4 + j] = Math.round(r[j] * 100) / 100;
  });
  return { t: glyphs.map(g => g.t), b, l: glyphs.map(g => g.line) };
}
