import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAll, searchable } from '../src/shared/text.mjs';
import { Paper, plainText } from '../src/server/paper.mjs';

// A page of glyphs laid out on lines 10pt apart; '\n' ends a line.
function page(lines) {
  const t = [], b = [], l = [];
  lines.forEach((line, li) => {
    [...line, '\n'].forEach((ch, i) => {
      t.push(ch);
      b.push(10 + i * 5, 100 + li * 10, ch === '\n' ? 0 : 5, ch === '\n' ? 0 : 8);
      l.push(li);
    });
  });
  return { t, b, l };
}

const p = page(['The singularity of five-', 'axis machines is a well', 'known problem.']);

test('search joins hyphenated line ends and ignores case and line breaks', () => {
  assert.equal(searchable(p).s.trim(), 'the singularity of fiveaxis machines is a well known problem.');
  assert.deepEqual(findAll(p, 'WELL KNOWN').length, 1);
  assert.deepEqual(findAll(p, 'fiveaxis').length, 1);
  assert.deepEqual(findAll(p, 'machines').map(([a, z]) => p.t.slice(a, z + 1).join('')), ['machines']);
  assert.equal(findAll(p, '   ').length, 0);
});

test('loose search matches a quote across punctuation and hyphenation', () => {
  assert.equal(findAll(p, 'five-axis machines, is', { loose: true }).length, 1);
  assert.equal(plainText(p), 'The singularity of fiveaxis machines is a well\\nknown problem.'.replace('\\n', '\n'));
});

test('quotes are located on the nearest page first, long quotes by their two ends', async () => {
  const other = page(['nothing here', 'The singularity of five-', 'axis machines']);
  const doc = { pageCount: 2, pages: [{ label: '1' }, { label: '2' }] };
  const paper = new Paper({ page: async (_, k) => (k === 1 ? other : p) });
  const near = await paper.locate(doc, 'singularity of five-axis', 2);
  assert.equal(near.page, 2);
  const first = await paper.locate(doc, 'singularity of five-axis');
  assert.equal(first.page, 1);
  assert.equal(first.rects.length, 2);
  const long = page(['Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon']);
  const p2 = new Paper({ page: async () => long });
  const fuzzy = await p2.locate({ pageCount: 1, pages: [{}] }, 'Alpha beta gamma delta epsilon zeta eta theta IOTA KAPPA (sic) lambda mu nu xi omicron pi rho sigma tau upsilon');
  assert.equal(fuzzy.page, 1);
  await assert.rejects(p2.locate({ pageCount: 1, pages: [{}] }, 'not in this paper at all'));
  assert.deepEqual((await paper.find(doc, 'machines')).map(h => h.page), [1, 2]);
});

test('math letters outside the BMP do not shift later matches', () => {
  const m = page(['the segment 𝐪(𝑢), and', 'ATOA is defined here']);
  const [[a, z]] = findAll(m, 'ATOA is defined', { loose: true });
  assert.equal(m.t.slice(a, z + 1).join(''), 'ATOA is defined');
  const [[b]] = findAll(m, 'atoa');
  assert.equal(m.t[b], 'A');
});

test('triple click selects the sentence, across lines, not stopping at abbreviations or decimals', async () => {
  const { sentenceAt, linesOf, textOf } = await import('../src/shared/text.mjs');
  const p2 = page(['Intro text ends here. As shown in Fig. 3 the', 'value 1.5 grows, see Wu et al. for details.', 'Next sentence.']);
  const lines = linesOf(p2);
  const i = p2.t.join('').indexOf('grows');
  const { a, z } = sentenceAt(p2, lines, i);
  assert.equal(p2.t.slice(a, z + 1).join('').replace(/\n/g, ' '), 'As shown in Fig. 3 the value 1.5 grows, see Wu et al. for details.');
  // At the foot of a column the sentence goes on at the top of the next one, past the running header.
  const cols = { t: [], b: [], l: [] };
  const put = (text, x, y, l) => [...text, '\n'].forEach((ch, k) => { cols.t.push(ch); cols.b.push(x + k * 5, y, ch === '\n' ? 0 : 5, ch === '\n' ? 0 : 8); cols.l.push(l); });
  put('left column bottom', 10, 500, 0);
  put('Journal header', 300, 30, 1);
  put('right column top', 300, 100, 2);
  const { a: c, z: d, skip } = sentenceAt(cols, linesOf(cols), 2, { height: 800 });
  const { rangesOf } = await import('../src/shared/text.mjs');
  assert.equal(rangesOf(c, d, skip).map(([x, y]) => textOf(cols, x, y)).join(' '), 'left column bottom right column top');
  // A subscript printed on the same line (PDFKit gives it its own line) does not end the sentence.
  const sub = { t: [], b: [], l: [] };
  const add = (text, x, y, h, l) => [...text].forEach((ch, k) => { sub.t.push(ch); sub.b.push(x + k * 5, y, 5, h); sub.l.push(l); });
  add('bounded by x', 10, 100, 10, 0);
  add('lim', 70, 104, 7, 1);
  add(' should hold.', 85, 100, 10, 2);
  const { a: e, z: f } = sentenceAt(sub, linesOf(sub), 2);
  assert.equal(sub.t.slice(e, f + 1).join(''), 'bounded by xlim should hold.');
});

test('a sentence open at the foot of a column goes on at the top of the next, skipping header and caption', async () => {
  const { sentenceAt, linesOf, rangesOf, textOf } = await import('../src/shared/text.mjs');
  const pg = { t: [], b: [], l: [] };
  let line = 0;
  const put = (text, x, y, h = 8) => { [...text, '\n'].forEach((ch, k) => { pg.t.push(ch); pg.b.push(x + k * 4, y, ch === '\n' ? 0 : 4, ch === '\n' ? 0 : h); pg.l.push(line); }); line++; };
  put('Earlier text ends. The sentence starts', 40, 700);          // left column, last two lines
  put('here and runs to the foot of', 40, 712);
  put('Journal Name 167 (2024)', 400, 20);                         // running header (top margin)
  put('Fig. 3. A caption under a figure.', 300, 200, 6);            // caption at the top of the right column
  put('the column, then ends. Next one.', 300, 400);               // right column body
  put('more right column text', 300, 412);
  const lines = linesOf(pg);
  const i = pg.t.join('').indexOf('runs');
  const s = sentenceAt(pg, lines, i, { height: 800 });
  const text = rangesOf(s.a, s.z, s.skip).map(([x, y]) => textOf(pg, x, y)).join(' ');
  assert.equal(text, 'The sentence starts here and runs to the foot of the column, then ends.');
  // Going back from the top of the right column finds the start in the left column too.
  const j = pg.t.join('').indexOf('then');
  const back = sentenceAt(pg, lines, j, { height: 800 });
  assert.equal(rangesOf(back.a, back.z, back.skip).map(([x, y]) => textOf(pg, x, y)).join(' '), text);
  // Text above in the same column (here: a heading over the abstract) means it is not a column top.
  const side = { t: [], b: [], l: [] };
  line = 0;
  const put2 = (text, x, y) => { [...text, '\n'].forEach((ch, k) => { side.t.push(ch); side.b.push(x + k * 4, y, ch === '\n' ? 0 : 4, ch === '\n' ? 0 : 8); side.l.push(line); }); line++; };
  put2('Keywords', 40, 300);
  put2('Smoothness', 40, 312);
  put2('ABSTRACT', 300, 270);
  put2('As an inherent flaw, it moves.', 300, 300);
  const k = side.t.join('').indexOf('inherent');
  const r = sentenceAt(side, linesOf(side), k, { height: 800 });
  assert.equal(textOf(side, r.a, r.z), 'As an inherent flaw, it moves.');
});
