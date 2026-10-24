import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPage } from '../src/server/outline.mjs';

const L = (text, y = 100) => ({ text, y, x0: 50, x1: 300 });

test('structure scan finds headings, captions and equation numbers, not references to them', () => {
  const r = scanPage([
    L('3.2 Two exclusion criteria and accurate detection'), L('Fig. 7. Illustration of admissible tool orientation annulus (ATOA).'),
    L('Fig. 1(c)) [2,5], through the analysis'), L('1 Initialization: Decompose 𝐂(𝑢) into segments'), L('2.9 GHz CPU and 32 G RAM. In this section'),
    L('𝐪(𝑢) = 𝐀𝑢 + 𝐁 (12)'), L('as shown in Eq. (12)'), L('Algorithm 1 Singularity detection'), L('References'), L('Table 2: Parameters used.'),
  ], 5);
  assert.deepEqual(r.sections.map(s => `${s.number} ${s.title}`), ['3.2 Two exclusion criteria and accurate detection', ' References']);
  assert.deepEqual(r.captions.map(c => `${c.kind}${c.label}`), ['图7', '算法1', '表2']);
  assert.deepEqual(r.equations.map(e => e.label), ['12']);
});
