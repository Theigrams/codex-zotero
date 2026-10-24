import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeText, packGlyphs } from '../src/server/textlayer.mjs';
import { hitGlyph, lineAt, linesOf, rectsOf, textOf, wordAt } from '../src/shared/text.mjs';

// A PDFKit page: "con gure Σ\nx𝑢y" where the "fi" ligature is missing and Σ came out as \u0002.
// Each visible char is 5pt wide on line 0 (y 10–20) or line 1 (y 30–40); 𝑢 is a surrogate pair.
function pdfkitPage() {
  const units = [];
  const add = (t, x, y) => { for (let k = 0; k < t.length; k++) units.push(x === null ? [0, 0, 0, 0] : [x, y, 5, 10]); };
  const text = 'con gure \u0002\nx𝑢y';
  let x = 0;
  for (const ch of 'con') { add(ch, x, 10); x += 5; }
  add(' ', null);            // PDFKit left a spurious space where the ligature was
  x += 5;                    // the missing "fi" sits at x = 15–20, touching "n" and "g"
  for (const ch of 'gure') { add(ch, x, 10); x += 5; }
  add(' ', null);
  add('\u0002', x + 5, 10);  // Σ at x = 45
  add('\n', null);
  add('x', 0, 30); add('𝑢', 5, 30); add('y', 10, 30);
  return { text, rects: units.flat(), lines: [[0, 10], [11, 4]] };
}

const mupdf = [
  ...'con'.split('').map((t, i) => ({ t, r: [i * 5, 9, 5, 12], src: 'unicode' })),
  { t: 'fi', r: [15, 9, 5, 12], src: 'ligature' },
  ...'gure'.split('').map((t, i) => ({ t, r: [20 + i * 5, 9, 5, 12], src: 'unicode' })),
  { t: 'Σ', r: [45, 9, 5, 12], src: 'embedded-glyph-name' },
  { t: 'x', r: [0, 29, 5, 12], src: 'unicode' },
  { t: '𝑢', r: [5, 29, 5, 12], src: 'unicode' },
  { t: 'y', r: [10, 29, 5, 12], src: 'unicode' },
];

test('merge repairs Σ in place and inserts the dropped ligature where it was drawn', () => {
  const g = mergeText(pdfkitPage(), mupdf);
  assert.equal(g.map(x => x.t).join(''), 'configure Σ\nx𝑢y');
  const fi = g.find(x => x.t === 'fi');
  assert.deepEqual(fi.r, [15, 9, 5, 12]);
  assert.equal(fi.line, 0);
  assert.deepEqual(g.find(x => x.t === 'Σ').r, [45, 10, 5, 10], 'geometry stays PDFKit\'s');
  assert.deepEqual(g.find(x => x.t === '𝑢').r, [5, 30, 5, 10], 'surrogate pairs keep their own rect');
});

test('a ligature after a real word space goes after the space', () => {
  // "of fl" where PDFKit kept only "of " + nothing: the fl glyph starts 3pt after "f".
  const pk = { text: 'of ow', rects: [[0, 0, 5, 10], [5, 0, 5, 10], [0, 0, 0, 0], [20, 0, 5, 10], [25, 0, 5, 10]].flat(), lines: [[0, 5]] };
  const g = mergeText(pk, [{ t: 'fl', r: [13, 0, 7, 10], src: 'ligature' }]);
  assert.equal(g.map(x => x.t).join(''), 'of flow');
});

test('without MuPDF the PDFKit text is used as is', () => {
  const g = mergeText(pdfkitPage(), null);
  assert.equal(g.map(x => x.t).join(''), 'con gure \u0002\nx𝑢y');
});

test('selection helpers: hit, word, line, text and rects', () => {
  const page = packGlyphs(mergeText(pdfkitPage(), mupdf));
  const lines = linesOf(page);
  assert.equal(lines.length, 2);
  const g = hitGlyph(page, lines, 22, 15);          // over "g"
  assert.equal(page.t[g], 'g');
  const [a, z] = wordAt(page, g);
  assert.equal(textOf(page, a, z), 'configure', 'the inserted ligature joins its word');
  assert.equal(page.t[hitGlyph(page, lines, 200, 15)], 'Σ', 'past the line end snaps to its last glyph');
  const [la, lz] = lineAt(page, hitGlyph(page, lines, 6, 35));
  assert.equal(textOf(page, la, lz), 'x𝑢y');
  assert.equal(textOf(page, 0, page.t.length - 1), 'configure Σ x𝑢y');
  const rects = rectsOf(page, 0, page.t.length - 1);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[1], [0, 30, 15, 10]);
});
