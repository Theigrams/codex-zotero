import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equationRegion, scanPage } from '../src/server/outline.mjs';

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

test('an equation box covers its rows within the column and stops at running text', () => {
  const R = (text, y, x0, x1, h = 8) => ({ text, y, y1: y + h, x0, x1 });
  const lines = [
    R('the left column has running text that ends at the gutter with justification', 300, 40, 290), // other column
    R('Inspired by this, the intersecting relationship is thus measured by the', 320, 306, 557),
    R('Bernstein-form polynomial as follows:', 332, 306, 420),
    R('𝑓(𝑢) = ∑ 𝐵𝑖,2𝑚(𝑢)𝑄𝑖', 346, 330, 470),
    R('𝑖=0', 356, 400, 412, 5),
    R('(8)', 352, 545, 557),
    R('𝑄𝑖 = [∑ (𝐪𝑠⋅𝐪𝑖−𝑠)] − 𝑟2', 366, 330, 480),
    R('and', 380, 306, 322),
    R('𝑅(𝑢) = 𝑁(𝑢)𝑤 (9)', 394, 330, 557),
  ];
  const [x, y, w, h] = equationRegion(lines, '8', 352);
  assert.ok(x > 300 && x < 306 && x + w > 557 && x + w < 562, `column ${x}..${x + w}`);
  assert.ok(y > 340 && y <= 346, `top ${y}: below the lead-in`);
  assert.ok(y + h >= 374 && y + h < 380, `bottom ${y + h}: above "and"`);
  assert.equal(equationRegion(lines, '12'), null);
  const [, y9] = equationRegion(lines, '9', 394);
  assert.ok(y9 > 386, 'a row opening with "and" separates two equations');
});
