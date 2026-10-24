// Layout math shared by the server (what to render) and the panel (where to put it).
// Both sides must agree to the pixel, so every rounding rule lives here. See docs/ARCHITECTURE.md.

export const RENDER_MODES = ['aligned', 'rounded'];
export const DEFAULT_RENDER_MODE = 'aligned';
export const STRIP_ROWS = 600;     // bitmap rows per strip
export const STRIP_OVERLAP = 2;    // extra rows under each 'rounded' strip so the browser-scaled seams never gap
export const GRAY_GAMMA = 'graygamma:1.3';
export const PREVIEW_WIDTH = 360;  // bitmap pixels
export const CROP_PADDING = 3;     // points kept around the union of content bounds

// How one page region (in points) maps to a bitmap and to CSS pixels.
//   aligned: bitmap width = CSS width × DPR, shown 1:1, then near-gray γ1.3.
//   rounded: scale rounded up to a 0.5 step, the browser shrinks the bitmap, no post-processing.
export function pagePlan(mode, cssWidth, dpr, region) {
  if (mode === 'rounded') {
    const target = (cssWidth * dpr) / region.w;
    const scale = Math.min(6, Math.max(1, Math.ceil(target * 2) / 2));
    const bitmapW = Math.ceil(region.w * scale);
    const bitmapH = Math.ceil(region.h * scale);
    return { mode, scale, bitmapW, bitmapH, cssW: cssWidth, cssH: (cssWidth * bitmapH) / bitmapW, key: `r${scale}` };
  }
  const bitmapW = Math.max(1, Math.round(cssWidth * dpr));
  const scale = bitmapW / region.w;
  const bitmapH = Math.max(1, Math.round(region.h * scale));
  return { mode: 'aligned', scale, bitmapW, bitmapH, cssW: bitmapW / dpr, cssH: bitmapH / dpr, key: `a${bitmapW}` };
}

// Horizontal strips covering a page bitmap. 'rounded' strips overlap the next one by STRIP_OVERLAP rows.
export function stripsFor(plan) {
  const extra = plan.mode === 'rounded' ? STRIP_OVERLAP : 0;
  const n = Math.ceil(plan.bitmapH / STRIP_ROWS);
  return Array.from({ length: n }, (_, index) => {
    const y = index * STRIP_ROWS;
    return { index, y, h: Math.min(STRIP_ROWS + extra, plan.bitmapH - y) };
  });
}

export function previewPlan(region) {
  const scale = PREVIEW_WIDTH / region.w;
  return { scale, bitmapW: PREVIEW_WIDTH, bitmapH: Math.max(1, Math.round(region.h * scale)) };
}

// One shared crop per page size: the union of every page's ink bounds (headers and page numbers
// included), padded and clamped. Sharing it keeps page widths, and so the zoom, identical while scrolling.
// pages: [{ width, height, bounds: [x, y, w, h] | null }] → [[x, y, w, h], ...]
export function cropRegions(pages, pad = CROP_PADDING) {
  const sizeKey = p => `${Math.round(p.width)}x${Math.round(p.height)}`;
  const unions = new Map();
  for (const p of pages) {
    if (!p.bounds) continue;
    const [x, y, w, h] = p.bounds;
    const u = unions.get(sizeKey(p));
    unions.set(sizeKey(p), u
      ? [Math.min(u[0], x), Math.min(u[1], y), Math.max(u[2], x + w), Math.max(u[3], y + h)]
      : [x, y, x + w, y + h]);
  }
  return pages.map(p => {
    const u = unions.get(sizeKey(p));
    if (!u) return [0, 0, p.width, p.height];
    const x0 = Math.max(0, u[0] - pad), y0 = Math.max(0, u[1] - pad);
    const x1 = Math.min(p.width, u[2] + pad), y1 = Math.min(p.height, u[3] + pad);
    return [x0, y0, x1 - x0, y1 - y0];
  });
}

export const fullRegion = page => [0, 0, page.width, page.height];
