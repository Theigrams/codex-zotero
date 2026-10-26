import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnit, recognizedCaptions, unitsOf } from '../src/shared/blocks.mjs';

const chart = (rect, caption) => ({ type: 'chart', rect, ...(caption ? { caption } : {}) });
const text = (rect, t = 'A paragraph of running text that goes on.') => ({ type: 'text', rect, text: t });

test('a figure takes its sub-figures before the caption, after it, and beside it in the other column', () => {
  const blocks = [
    chart([50, 100, 200, 100]),                                // 0 left column, read first
    chart([50, 210, 200, 100]),                                // 1
    text([300, 60, 250, 30]),                                  // 2 right column text in between
    chart([300, 100, 200, 100]),                               // 3
    { type: 'text', rect: [300, 205, 10, 8], text: '(c)' },    // 4 a sub-figure letter
    chart([300, 210, 200, 100], 'd Fig. 3. Results.'),         // 5 caption on the last one
    chart([300, 320, 200, 60]),                                // 6 right after it
    text([50, 400, 500, 80]),                                  // 7
    chart([50, 500, 200, 100]),                                // 8 MinerU lost this one's caption
    { type: 'equation', rect: [50, 620, 200, 30], labels: ['4'] },
  ];
  const units = unitsOf(blocks);
  const fig = units.find(u => u.label === '3');
  assert.deepEqual([...fig.blocks].sort((a, b) => a - b), [0, 1, 3, 4, 5, 6]);
  assert.deepEqual(fig.rect, [50, 100, 450, 280]);
  assert.equal(fig.caption, 'Results.');
  assert.deepEqual(units.filter(u => u.kind === 'fig' && !u.label).map(u => u.blocks), [[8]], 'a figure without a caption stays on its own');
  assert.deepEqual(units.find(u => u.kind === 'eq').labels, ['4']);
});

test('a jump picks the unit it points at', () => {
  const blocks = [
    text([50, 50, 250, 200]),
    { type: 'equation', rect: [50, 300, 250, 40], labels: ['1'] },
    { type: 'equation', rect: [320, 300, 250, 40], labels: ['2'] },
    chart([50, 400, 250, 150], 'Fig. 1. A figure.'),
    { type: 'table', rect: [320, 450, 250, 100], caption: 'Table 2 Limits' },
    { type: 'ref_text', rect: [320, 600, 250, 20], text: '[1] A. Author, A paper.' },
  ];
  const units = unitsOf(blocks);
  const at = (y, x, kind) => pickUnit(units, { y, x, kind })?.rect;
  assert.deepEqual(at(305, 175, 'eq'), [50, 300, 250, 40], 'the equation the point is in');
  assert.deepEqual(at(305, 445, 'eq'), [320, 300, 250, 40], 'the other column by x');
  assert.deepEqual(at(560, 175, 'fig'), [50, 400, 250, 150], 'a caption line under the figure (no caption box) still finds it');
  assert.deepEqual(at(430, 445, 'tab'), [320, 450, 250, 100], 'a table caption over the table');
  assert.equal(at(560, 175, 'eq'), undefined, 'kind must match');
  assert.deepEqual(at(598, 330), [320, 600, 250, 20], 'a link without a kind: a reference from its top');
  assert.equal(at(150, 100), undefined, 'not the middle of a paragraph');
  assert.equal(at(700, 175, 'fig'), undefined, 'too far');
});

test('numbered figures and tables become captions for the structure index', () => {
  const index = { pages: [{ blocks: [chart([50, 400, 250, 150], 'Fig. 1. A figure.'), { type: 'table', rect: [320, 450, 250, 100], caption: 'Table 2: Limits' }] }, { blocks: [chart([50, 50, 100, 100], 'Fig. 1 again')] }] };
  assert.deepEqual(recognizedCaptions(index), [
    { kind: '图', label: '1', page: 1, y: 400, x: 175, text: 'A figure.', rect: [50, 400, 250, 150] },
    { kind: '表', label: '2', page: 1, y: 450, x: 445, text: 'Limits', rect: [320, 450, 250, 100] },
  ]);
});
