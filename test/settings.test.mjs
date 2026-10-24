import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PALETTE, cleanPalette, qaEntry, tagsForColor, toZotero } from '../src/shared/annotations.mjs';
import { DEFAULT_KEYS, actionFor, comboOf, keymap, reserved, showCombo } from '../src/shared/keys.mjs';
import { linesOf, targetBlock } from '../src/shared/text.mjs';
import { State } from '../src/server/state.mjs';

test('a palette is checked before it is saved', () => {
  assert.throws(() => cleanPalette([]), /至少/);
  assert.throws(() => cleanPalette(Array.from({ length: 10 }, (_, i) => ({ color: `#0000${10 + i}`, tag: `t${i}` }))), /最多/);
  assert.throws(() => cleanPalette([{ color: '#ffd400', tag: 'a' }, { color: '#FFD400', tag: 'b' }]), /颜色不能重复/);
  assert.throws(() => cleanPalette([{ color: '#ffd400', tag: 'a' }, { color: '#ff6666', tag: ' a ' }]), /标签不能重复/);
  assert.throws(() => cleanPalette([{ color: 'red', tag: 'a' }]), /颜色无效/);
  const p = cleanPalette([{ color: '#FFD400', tag: ' 重点 ' }, { color: '#e56eee', tag: '问答', qa: true }]);
  assert.deepEqual(p, [{ color: '#ffd400', tag: '重点' }, { color: '#e56eee', tag: '问答' }]);
  assert.deepEqual(qaEntry(p), { color: '#e56eee', tag: '问答' }, 'the row tagged 问答 is for AI answers');
  assert.deepEqual(qaEntry([{ color: '#ffd400', tag: 'only' }]), { color: '#a28ae5', tag: null }, 'without one, answers are purple');
  assert.equal(qaEntry(DEFAULT_PALETTE).tag, '问答');
});

test('a custom palette decides the tag a color gets', () => {
  const palette = [{ color: '#e56eee', tag: '方法' }, { color: '#ffd400', tag: '要点' }];
  assert.deepEqual(tagsForColor([{ tag: '自己的' }, { tag: '方法' }], '#ffd400', palette), [{ tag: '自己的' }, { tag: '要点' }]);
  assert.deepEqual(tagsForColor([{ tag: '方法' }], '#123456', palette), [], 'a color outside the palette carries no palette tag');
  const doc = { attachmentKey: 'ATTKEY01', pages: [{ width: 600, height: 800, originX: 0, originY: 0 }] };
  const z = toZotero(doc, { kind: 'text', page: 1, rects: [[10, 10, 50, 10]], text: 'x' }, { color: '#e56eee', palette });
  assert.deepEqual(z.tags, [{ tag: '方法' }]);
});

test('key combos: physical letters, reserved keys, display', () => {
  assert.equal(comboOf({ code: 'KeyF', key: 'ƒ', altKey: true }), 'Alt+f', '⌥F on a Mac types ƒ');
  assert.equal(comboOf({ code: 'ArrowLeft', key: 'ArrowLeft', altKey: true }), 'Alt+ArrowLeft');
  assert.equal(comboOf({ code: 'KeyD', key: 'D', shiftKey: true }), 'Shift+d');
  assert.equal(comboOf({ code: 'Comma', key: ',', metaKey: true }), 'Meta+,');
  assert.equal(comboOf({ code: 'AltLeft', key: 'Alt', altKey: true }), null);
  for (const c of ['1', 'Shift+9', 'Escape', 'Meta+3', 'Meta+c']) assert.ok(reserved(c), c);
  for (const c of ['Alt+ArrowLeft', 'Meta+[', 'b', 'Meta+0']) assert.ok(!reserved(c), c);
  assert.equal(showCombo('Alt+ArrowLeft'), '⌥←');
  assert.equal(showCombo('Shift++'), '⇧+');
  assert.equal(showCombo(null), '未设置');
  const map = keymap({ back: 'Meta+[', forward: null });
  assert.equal(actionFor(map, 'Meta+['), 'back');
  assert.equal(actionFor(map, 'Alt+ArrowLeft'), null);
  assert.equal(actionFor(map, 'Alt+ArrowRight'), null, 'unbound');
  assert.equal(actionFor(keymap(), DEFAULT_KEYS.find), 'find');
  assert.equal(new Set(Object.values(DEFAULT_KEYS)).size, Object.keys(DEFAULT_KEYS).length, 'defaults do not collide');
  assert.ok(Object.values(DEFAULT_KEYS).every(c => !reserved(c)));
});

test('preferences keep palette, keys and the map prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-prefs-'));
  try {
    const state = new State(root);
    assert.deepEqual((await state.prefs()).palette, DEFAULT_PALETTE);
    await state.setPrefs({ palette: [{ color: '#e56eee', tag: '方法' }] });
    assert.deepEqual((await state.prefs()).palette, [{ color: '#e56eee', tag: '方法' }]);
    await state.setPrefs({ palette: null });
    assert.deepEqual((await state.prefs()).palette, DEFAULT_PALETTE);
    assert.equal((await readFile(join(root, 'preferences.json'), 'utf8')).includes('palette'), false, 'the default is not stored');
    // A palette saved as the first default (疑问 flagged for answers) gives way to the current default.
    await writeFile(join(root, 'preferences.json'), JSON.stringify({ palette: [
      { color: '#ffd400', tag: '重点' }, { color: '#a28ae5', tag: '疑问', qa: true }, { color: '#2ea8e5', tag: '定义' }, { color: '#5fb236', tag: '启发' }, { color: '#ff6666', tag: '存疑' },
    ] }));
    assert.deepEqual((await state.prefs()).palette, DEFAULT_PALETTE);
    await state.setPrefs({ keys: { back: 'Meta+[', nonsense: 'x' } });
    assert.deepEqual((await state.prefs()).keys, { back: 'Meta+[' });
    await assert.rejects(state.setPrefs({ keys: { back: '1' } }), /快捷键无效/);
    await state.setPrefs({ mapPrompt: '只写三段。', mapModel: 'gpt-6-luna' });
    const p = await state.prefs();
    assert.equal(p.mapPrompt, '只写三段。');
    assert.equal(p.mapModel, 'gpt-6-luna');
    await assert.rejects(state.setPrefs({ mapModel: 'rm -rf /' }), /模型名称无效/);
    await state.setPrefs({ mapEffort: 'high' });
    assert.equal((await state.prefs()).mapEffort, 'high');
    await state.setPrefs({ mapEffort: 'medium' });
    assert.equal((await state.prefs()).mapEffort, '', 'medium is the default');
    await assert.rejects(state.setPrefs({ mapEffort: 'max' }), /推理强度/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A two-column page: columns at x 40–280 and 310–550, lines 12pt apart, 4pt glyphs.
function twoColumns() {
  const pg = { t: [], b: [], l: [] };
  let line = 0;
  const put = (text, x, y) => {
    [...text, '\n'].forEach((ch, k) => { pg.t.push(ch); pg.b.push(x + k * 4, y, ch === '\n' ? 0 : 4, ch === '\n' ? 0 : 8); pg.l.push(line); });
    line++;
  };
  const body = 'x'.repeat(60);
  put(`Fig. 1. ${'c'.repeat(118)}`, 40, 40); // a caption across both columns above
  for (let y = 100; y <= 124; y += 12) put(body, 40, y);
  put('f(x) = g(x) + h(x)   (1)', 100, 140); // display equation in the left column
  put('     = ' + 'k'.repeat(48), 44, 150); // its second line, nearly as wide as the column but indented
  put('    ' + 'x'.repeat(56), 40, 164); // the next paragraph, first line indented
  for (let y = 176; y <= 290; y += 12) put(body, 40, y);
  put('Fig. 2. A figure in one column.', 40, 410); // figure drawn at 300–400, caption under it
  for (let y = 100; y <= 430; y += 12) put(body, 310, y);
  put('Fig. 5. A figure across both columns.', 236, 640); // caption centred over the gutter
  return pg;
}

test('the box a link outlines stays in its column unless the figure spans both', () => {
  const pg = twoColumns();
  const lines = linesOf(pg);
  const within = ([x, , w], a, b) => x >= a - 4 && x + w <= b + 4;
  const eq = targetBlock(pg, lines, { x: 120, y: 140, kind: 'eq' });
  assert.ok(within(eq, 40, 280), `equation box ${eq} is inside the left column`);
  assert.ok(eq[1] > 132 && eq[1] + eq[3] > 158 && eq[1] + eq[3] < 164, `both equation lines, not the paragraph below: ${eq}`);
  const fig = targetBlock(pg, lines, { x: 40, y: 410, kind: 'fig' });
  assert.ok(within(fig, 40, 280), `single-column figure ${fig}`);
  assert.ok(fig[1] < 302 && fig[1] > 290 && fig[1] + fig[3] >= 418, `from under the text above to the caption: ${fig}`);
  assert.equal(targetBlock(pg, lines, { y: 140, kind: 'eq' }), null, 'without x, a height shared by two columns is not guessed');
  const wide = targetBlock(pg, lines, { x: 236, y: 640, kind: 'fig' });
  assert.ok(wide[0] <= 40 && wide[0] + wide[2] >= 550, `two-column figure ${wide}`);
});

test('preference saves made at the same time do not undo each other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-prefs-'));
  try {
    const state = new State(root);
    await Promise.all([state.setPrefs({ mapPrompt: 'a' }), state.setPrefs({ keys: { back: 'Meta+[' } }), state.setPrefs({}), state.setPrefs({ renderMode: 'blur' }).catch(() => {}), state.setPrefs({ mapModel: 'm' })]);
    const p = await state.prefs();
    assert.deepEqual([p.mapPrompt, p.keys.back, p.mapModel], ['a', 'Meta+[', 'm']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
