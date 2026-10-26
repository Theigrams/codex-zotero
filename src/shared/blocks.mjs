// Blocks of a recognized page (MinerU, src/server/recognition.mjs: { type, rect, text, latex?, labels?, caption?,
// captionRect?, ... }) grouped into what a jump points at: one equation, one table, one figure with all its
// sub-figures and caption. Pure functions, so they run in the server, the panel and the unit tests alike.
// Rects are page points from the top left.

const FIGURE = new Set(['image', 'chart']);
// Captions can open with the sub-figure letters MinerU joined to them: "b Fig. 2. …".
const captioned = word => new RegExp(`^\\s*(?:\\(?[a-z]\\)?\\s+)*(?:${word})\\s*(\\d{1,3})`, 'i');
const FIG_CAPTION = captioned('fig\\.?|figure|图');
const TAB_CAPTION = captioned('table|tab\\.|表');
const ALG_CAPTION = captioned('algorithm|alg\\.|算法');
// A sub-figure letter MinerU put in a block of its own: "(a)", "b".
const tiny = b => !FIGURE.has(b.type) && b.type !== 'equation' && b.type !== 'table' && String(b.text || '').trim().length <= 6;

export const union = rects => {
  const rs = rects.filter(Boolean);
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map(r => r[0])), y0 = Math.min(...rs.map(r => r[1]));
  const x1 = Math.max(...rs.map(r => r[0] + r[2])), y1 = Math.max(...rs.map(r => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
};

// → [{ kind: 'eq' | 'fig' | 'tab' | 'alg' | null, label?, labels?, caption?, rect, blocks: [index] }] in reading order.
// A figure's caption sits on one of its sub-figures (usually the last): the sub-figures without a caption before
// it belong to it, and so do any right after it. Sub-figures set beside it in the other column (MinerU reads one
// column, then the other) join it when they span the same height. Others stay apart: MinerU missed their caption,
// and which of them form one figure can't be told.
export function unitsOf(blocks) {
  const units = [];
  let pending = [];   // uncaptioned sub-figures (and their letters) waiting for a caption
  let lastFig = null; // the figure just closed: sub-figures right after it, uncaptioned, are its own
  const rectOf = indexes => union(indexes.flatMap(i => [blocks[i].rect, blocks[i].captionRect]));
  const add = (u, indexes) => {
    Object.assign(u, { blocks: indexes, rect: rectOf(indexes) });
    units.push(u);
    return u;
  };
  const flush = () => {
    if (lastFig && pending.some(i => FIGURE.has(blocks[i].type))) {
      lastFig.blocks.push(...pending);
      lastFig.rect = rectOf(lastFig.blocks);
    } else {
      for (const i of pending) add({ kind: FIGURE.has(blocks[i].type) ? 'fig' : null }, [i]);
    }
    pending = [];
    lastFig = null;
  };
  blocks.forEach((b, i) => {
    const caption = String(b.caption || '');
    if (FIGURE.has(b.type)) {
      const m = caption.match(FIG_CAPTION);
      if (!m) return pending.push(i);
      lastFig = add({ kind: 'fig', label: m[1], caption: caption.slice(m.index + m[0].length).replace(/^\s*[.:|]?\s*/, '') }, [...pending, i]);
      pending = [];
      return;
    }
    if (tiny(b) && (pending.length || lastFig)) return pending.push(i);
    flush();
    const tab = caption.match(TAB_CAPTION), alg = caption.match(ALG_CAPTION);
    if (b.type === 'equation') add({ kind: 'eq', ...(b.labels ? { labels: b.labels } : {}) }, [i]);
    else if (b.type === 'table') add({ kind: 'tab', ...(tab ? { label: tab[1] } : {}), caption }, [i]);
    else if ((b.type === 'code' || b.type === 'algorithm') && alg) add({ kind: 'alg', label: alg[1], caption }, [i]);
    else add({ kind: null }, [i]);
  });
  flush();
  // Uncaptioned sub-figures beside a captioned figure, over the same height, are part of it.
  const span = r => [r[1], r[1] + r[3]];
  const overlap = (a, b) => Math.max(0, Math.min(span(a)[1], span(b)[1]) - Math.max(span(a)[0], span(b)[0]));
  for (const u of units.filter(u => u.kind === 'fig' && !u.label && u.rect)) {
    const into = units.filter(f => f.kind === 'fig' && f.label && f.rect)
      .map(f => [f, overlap(u.rect, f.rect)]).filter(([f, o]) => o >= 0.5 * Math.min(u.rect[3], f.rect[3]))
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!into) continue;
    into.blocks.push(...u.blocks);
    into.rect = rectOf(into.blocks);
    u.merged = true;
  }
  return units.filter(u => u.rect && !u.merged);
}

// How far (pt) a link's point may lie outside the unit it means, above and below. A figure's caption is under
// it and a table's over it, and the official service gives no box for captions; text is only meant from its top.
const REACH = { eq: [12, 12], fig: [16, 60], tab: [60, 16], alg: [60, 16] };
const SIDE = 40; // pt left or right: an equation's number can sit outside its box

// The unit a jump target means: at = { x?, y, kind? } (kind from a note link; none for a link inside the paper).
export function pickUnit(units, { x = null, y, kind = null }) {
  let best = null, bestScore = Infinity;
  for (const u of units) {
    if (kind && u.kind !== kind) continue;
    const [ux, uy, uw, uh] = u.rect;
    if (x != null && (x < ux - SIDE || x > ux + uw + SIDE)) continue;
    const [above, below] = REACH[u.kind] || [16, 16];
    if (y < uy - above || y > uy + uh + below) continue;
    // Running text (a reference, a paragraph) only from near its top: a link into the middle of a long
    // paragraph means a line, not the paragraph.
    if (!u.kind && Math.abs(y - uy) > 20) continue;
    const outside = y < uy ? uy - y : y > uy + uh ? y - uy - uh : 0;
    const score = outside * 4 + Math.abs(y - uy) / 100;
    if (score < bestScore) {
      best = u;
      bestScore = score;
    }
  }
  return best;
}

// Numbered figures, tables and algorithms of a recognized paper, in the shape of the structure index's captions
// (outline.mjs): [{ kind: '图' | '表' | '算法', label, page, y, x, text, rect }] — y, x: top and centre of the whole
// figure, where links point.
const KIND_NAME = { fig: '图', tab: '表', alg: '算法' };
export function recognizedCaptions(index) {
  const out = [];
  const seen = new Set();
  index.pages.forEach((p, i) => {
    for (const u of unitsOf(p.blocks)) {
      if (!KIND_NAME[u.kind] || !u.label || seen.has(u.kind + u.label)) continue;
      seen.add(u.kind + u.label);
      const text = u.kind === 'fig' ? u.caption : u.caption.replace(u.kind === 'tab' ? TAB_CAPTION : ALG_CAPTION, '').replace(/^\s*[.:|]?\s*/, '');
      out.push({ kind: KIND_NAME[u.kind], label: u.label, page: i + 1, y: Math.round(u.rect[1]), x: Math.round(u.rect[0] + u.rect[2] / 2), text: text.slice(0, 120), rect: u.rect });
    }
  });
  return out;
}
