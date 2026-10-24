// Annotation colors and the conversion between Zotero positions and reader coordinates.
// Reader: PDF points, top-left origin, relative to the page crop box; rects are [x, y, w, h].
// Zotero: PDF user space (bottom-left origin, absolute); rects are [x1, y1, x2, y2].

// The user's palette: an ordered list of { color, tag } (keys 1–9 in this order, H = the
// first). Each annotation made with a color also gets its tag. The row tagged 问答 is the color saved AI
// answers use. Editable in the settings drawer; this is the default.
export const QA_COLOR_TAG = '问答';
export const DEFAULT_PALETTE = [
  { color: '#ffd400', tag: '重点' },
  { color: '#a28ae5', tag: QA_COLOR_TAG },
  { color: '#2ea8e5', tag: '定义' },
  { color: '#5fb236', tag: '启发' },
  { color: '#ff6666', tag: '存疑' },
];
// Zotero's own preset colors, offered when picking one (Zotero shows them with the same names).
export const ZOTERO_COLORS = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa'];
export const DEFAULT_COLOR = DEFAULT_PALETTE[0].color;
export const QA_TAG = 'AI问答';
const MAX_PALETTE = 9;

export const colorInfo = (color, palette = DEFAULT_PALETTE) => palette.find(c => c.color === String(color).toLowerCase()) || null;
// Without a 问答 row, saved answers are purple and carry only the AI问答 tag.
export const qaEntry = (palette = DEFAULT_PALETTE) => palette.find(c => c.tag === QA_COLOR_TAG) || { color: '#a28ae5', tag: null };

// Keeps every tag the user set elsewhere and swaps only the palette's tag.
export function tagsForColor(tags, color, palette = DEFAULT_PALETTE) {
  const ours = palette.map(c => c.tag);
  const kept = tags.filter(t => !ours.includes(t.tag));
  const info = colorInfo(color, palette);
  return info ? [...kept, { tag: info.tag }] : kept;
}

// A palette as saved from the settings: 1–9 entries, valid colors, non-empty distinct tags.
export function cleanPalette(p) {
  if (!Array.isArray(p) || !p.length) throw new Error('至少需要一种颜色。');
  if (p.length > MAX_PALETTE) throw new Error(`最多 ${MAX_PALETTE} 种颜色（对应按键 1–9）。`);
  const out = p.map(e => ({ color: String(e.color || '').toLowerCase(), tag: String(e.tag || '').trim().slice(0, 30) }));
  for (const e of out) {
    if (!/^#[0-9a-f]{6}$/.test(e.color)) throw new Error(`颜色无效：${e.color}`);
    if (!e.tag) throw new Error('标签不能为空。');
  }
  if (new Set(out.map(e => e.tag)).size !== out.length) throw new Error('标签不能重复。');
  if (new Set(out.map(e => e.color)).size !== out.length) throw new Error('颜色不能重复。');
  return out;
}

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

// g: { width, height, originX, originY } of the page's crop box.
export const rectFromZotero = (g, [x1, y1, x2, y2]) =>
  [r2(x1 - g.originX), r2(g.originY + g.height - y2), r2(x2 - x1), r2(y2 - y1)];

export const rectToZotero = (g, [x, y, w, h]) =>
  [r3(x + g.originX), r3(g.originY + g.height - y - h), r3(x + w + g.originX), r3(g.originY + g.height - y)];

const pathFromZotero = (g, path) => path.map((v, i) => (i % 2 ? r2(g.originY + g.height - v) : r2(v - g.originX)));

// A Zotero annotation item → what the panel draws and edits; null for positions this reader can't place.
export function fromZotero(item, pages) {
  const d = item.data;
  let pos;
  try {
    pos = JSON.parse(d.annotationPosition);
  } catch {
    return null;
  }
  const page = pos.pageIndex + 1;
  const g = pages[page - 1];
  if (!g || !Number.isInteger(pos.pageIndex)) return null;
  const a = {
    key: item.key, version: item.version ?? d.version, type: d.annotationType, color: (d.annotationColor || DEFAULT_COLOR).toLowerCase(),
    page, rects: (pos.rects || []).map(r => rectFromZotero(g, r)), text: d.annotationText || '', comment: d.annotationComment || '',
    tags: (d.tags || []).map(t => t.tag), pageLabel: d.annotationPageLabel || String(page), sortIndex: d.annotationSortIndex || '',
  };
  const next = pages[page];
  if (pos.nextPageRects?.length && next) a.nextRects = pos.nextPageRects.map(r => rectFromZotero(next, r));
  if (d.annotationType === 'ink' && Array.isArray(pos.paths)) {
    a.paths = pos.paths.map(p => pathFromZotero(g, p));
    a.width = pos.width || 1;
  }
  return a.rects.length || a.paths?.length ? a : null;
}

// Sort index Zotero uses to order annotations: page | text offset | distance from the top.
export const sortIndex = (page, offset, top) =>
  `${String(page - 1).padStart(5, '0')}|${String(Math.max(0, offset)).padStart(6, '0')}|${String(Math.max(0, Math.round(top))).padStart(5, '0')}`;

// A new annotation from a reader selection. sel: { kind: 'text'|'region', page, rects, text, offset }.
export function toZotero({ attachmentKey, pages }, sel, { color = DEFAULT_COLOR, type = 'highlight', comment = '', tags = [], palette = DEFAULT_PALETTE } = {}) {
  const g = pages[sel.page - 1];
  if (!g) throw new Error('页码超出范围。');
  if (!sel.rects?.length) throw new Error('选区没有位置。');
  for (const [x, y, w, h] of sel.rects) {
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x < -1 || y < -1 || x + w > g.width + 1 || y + h > g.height + 1) throw new Error('选区超出页面。');
  }
  const region = sel.kind === 'region';
  if (!region && !sel.text?.trim()) throw new Error('选区没有文字。');
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('颜色无效。');
  if (!region && !['highlight', 'underline'].includes(type)) throw new Error('批注类型无效。');
  return {
    itemType: 'annotation', parentItem: attachmentKey,
    annotationType: region ? 'image' : type,
    ...(region ? {} : { annotationText: sel.text }),
    annotationComment: comment, annotationColor: color.toLowerCase(), annotationPageLabel: g.label || String(sel.page),
    annotationSortIndex: sortIndex(sel.page, sel.offset || 0, Math.min(...sel.rects.map(r => r[1]))),
    annotationPosition: JSON.stringify({ pageIndex: sel.page - 1, rects: sel.rects.map(r => rectToZotero(g, r)) }),
    tags: tagsForColor(tags.map(tag => ({ tag })), color, palette),
  };
}
