import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRIP_OVERLAP, STRIP_ROWS, cropRegions, pagePlan, stripsFor } from '../src/shared/layout.mjs';

const A4 = { w: 595.276, h: 793.701 };

test('aligned: bitmap is exactly CSS width × DPR and shown 1:1', () => {
  for (const css of [420, 700, 900, 1026, 1100]) {
    const p = pagePlan('aligned', css, 2, A4);
    assert.equal(p.bitmapW, css * 2);
    assert.equal(p.cssW * 2, p.bitmapW);
    assert.equal(p.cssH * 2, p.bitmapH);
  }
});

test('aligned matches the render-compare reference sizes', () => {
  // Blind-test renders: 900 CSS px at DPR 2 → 1800×2400, 1026 → 2052×2736.
  assert.deepEqual([pagePlan('aligned', 900, 2, A4).bitmapW, pagePlan('aligned', 900, 2, A4).bitmapH], [1800, 2400]);
  assert.deepEqual([pagePlan('aligned', 1026, 2, A4).bitmapW, pagePlan('aligned', 1026, 2, A4).bitmapH], [2052, 2736]);
});

test('rounded: same formula as the 0.12.0 single-page mode', () => {
  // Old panel: scale = min(6, max(1, ceil(cssWidth / pageWidth * dpr * 2) / 2)).
  assert.equal(pagePlan('rounded', 700, 2, A4).scale, 2.5);
  assert.equal(pagePlan('rounded', 900, 2, A4).scale, 3.5);
  assert.equal(pagePlan('rounded', 1026, 2, A4).scale, 3.5);
  const p = pagePlan('rounded', 1026, 2, A4);
  assert.deepEqual([p.bitmapW, p.bitmapH], [2084, 2778]);
  assert.ok(p.bitmapW >= p.cssW * 2, 'never upscaled by the browser');
  assert.equal(p.cssW, 1026);
});

test('rounded widths inside one 0.5 step share a cache key', () => {
  assert.equal(pagePlan('rounded', 1000, 2, A4).key, pagePlan('rounded', 1030, 2, A4).key);
  assert.notEqual(pagePlan('aligned', 1000, 2, A4).key, pagePlan('aligned', 1030, 2, A4).key);
});

test('strips cover the bitmap exactly; rounded strips overlap the next one', () => {
  const a = pagePlan('aligned', 1026, 2, A4);
  const sa = stripsFor(a);
  assert.equal(sa.length, Math.ceil(a.bitmapH / STRIP_ROWS));
  assert.equal(sa.reduce((n, s) => n + s.h, 0), a.bitmapH);
  sa.slice(1).forEach((s, i) => assert.equal(s.y, sa[i].y + sa[i].h));

  const r = pagePlan('rounded', 1026, 2, A4);
  const sr = stripsFor(r);
  sr.slice(0, -1).forEach(s => assert.equal(s.h, STRIP_ROWS + STRIP_OVERLAP));
  const last = sr.at(-1);
  assert.equal(last.y + last.h, r.bitmapH);
});

test('crop: one padded union per page size, clamped, empty pages fall back', () => {
  const pages = [
    { width: 600, height: 800, bounds: [50, 40, 500, 700] },
    { width: 600, height: 800, bounds: [45, 60, 520, 690] },
    { width: 600, height: 800, bounds: null },
    { width: 400, height: 500, bounds: null },
  ];
  const [a, b, c, d] = cropRegions(pages, 3);
  assert.deepEqual(a, [42, 37, 526, 716]);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a, 'a blank page keeps its siblings\' crop');
  assert.deepEqual(d, [0, 0, 400, 500]);
  const edge = cropRegions([{ width: 100, height: 100, bounds: [0, 1, 100, 98] }], 3)[0];
  assert.deepEqual(edge, [0, 0, 100, 100]);
});
