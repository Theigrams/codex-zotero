import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdownToNote, mapInfo, mapNoteHTML, runCodex } from '../src/server/map.mjs';
import { noteText } from '../src/server/notes.mjs';

const fake = new URL('./fake-codex.mjs', import.meta.url).pathname;

test('a map in Markdown becomes a Zotero note: headings, lists, tables, Zotero math nodes', () => {
  const html = markdownToNote('## 结构\n- [p.1] **1 Intro**：提出 $x<y$\n1. 第一步\n\n2. 第二步\n   接续一行\n\n$$E=\\int_0^1 J^2$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n普通段落 `code`');
  assert.match(html, /<h2>结构<\/h2>/);
  assert.match(html, /<li>\[p\.1\] <strong>1 Intro<\/strong>：提出 <span class="math">\$x&lt;y\$<\/span><\/li>/);
  assert.match(html, /<ol><li>第一步<\/li><li>第二步 接续一行<\/li><\/ol>/);
  assert.match(html, /<pre class="math">\$\$E=\\int_0\^1 J\^2\$\$<\/pre>/);
  assert.match(html, /<table><tr><th>a<\/th><th>b<\/th><\/tr><tr><td>1<\/td><td>2<\/td><\/tr><\/table>/);
  assert.match(html, /<p>普通段落 <code>code<\/code><\/p>/);
  assert.ok(!/<script/.test(markdownToNote('<script>alert(1)</script>')));
});

test('the map note says what made it, when and for which PDF', () => {
  const html = mapNoteHTML('## 一句话\n内容', { title: 'Paper', model: 'gpt-6.1-sol', date: '2026-10-24', fingerprint: 'e20f95bd9134' });
  assert.ok(noteText(html).startsWith('# 论文地图：Paper'));
  assert.deepEqual(mapInfo(html), { model: 'gpt-6.1-sol', date: '2026-10-24', fingerprint: 'e20f95bd9134', status: '未核验' });
});

test('runCodex passes the material on stdin and reads the -o file', async () => {
  const r = await runCodex('=== 第 1 页 ===\n=== 第 2 页 ===', { codex: fake });
  assert.match(r.text, /共 2 页/);
  assert.equal(r.threadId, 'fake-thread-1');
  process.env.FAKE_CODEX_FAIL = '1';
  try {
    await assert.rejects(runCodex('x', { codex: fake }), /退出码 1.*model unavailable/);
  } finally {
    delete process.env.FAKE_CODEX_FAIL;
  }
  await assert.rejects(runCodex('x', { codex: '/no/such/codex' }), /无法启动/);
  const argsFile = join(tmpdir(), `fake-codex-args-${process.pid}.json`);
  process.env.FAKE_CODEX_ARGS = argsFile;
  try {
    await runCodex('x', { codex: fake });
    assert.ok(JSON.parse(readFileSync(argsFile, 'utf8')).includes('model_reasoning_effort="medium"'), 'medium by default');
    await runCodex('x', { codex: fake, model: 'm1', effort: 'high' });
    const args = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.ok(args.includes('model_reasoning_effort="high"') && args[args.indexOf('-m') + 1] === 'm1', args.join(' '));
  } finally {
    delete process.env.FAKE_CODEX_ARGS;
    rmSync(argsFile, { force: true });
  }
  await assert.rejects(runCodex('x', { codex: fake, effort: 'max' }), /推理强度/);
});

test('a | inside a formula or escaped does not split a table cell', () => {
  const html = markdownToNote('| 式 | 含义 |\n|---|---|\n| $\\|x\\|$ 与 $|y|$ | a \\| b |');
  assert.match(html, /<td><span class="math">\$\\\|x\\\|\$<\/span> 与 <span class="math">\$\|y\|\$<\/span><\/td><td>a \| b<\/td>/);
});

test('page, equation, figure, table and algorithm references link back into the PDF', () => {
  const outline = {
    equations: [{ label: '11', page: 8, y: 735 }, { label: '7a', page: 5, y: 594 }],
    captions: [{ kind: '图', label: '7', page: 7, y: 276 }, { kind: '表', label: '2', page: 16, y: 80 }, { kind: '算法', label: '1', page: 6, y: 269 }],
  };
  const refs = { attachmentKey: 'ATTACH01', pageCount: 20, outline };
  const html = markdownToNote('- 目标见式（11）与式 (7a–b)，图 7、表 2、算法 1 [p.3–4, p.9]；式 (99) 与图 70 不链接 [p.99]\n- 公式里的 $p.3$ 不动', refs);
  const links = [...html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[2], m[1].replace(/&amp;/g, '&')]);
  assert.deepEqual(links, [
    ['式（11）', 'zotero://open-pdf/library/items/ATTACH01?page=8&y=735&k=eq'],
    ['式 (7a–b)', 'zotero://open-pdf/library/items/ATTACH01?page=5&y=594&k=eq'],
    ['图 7', 'zotero://open-pdf/library/items/ATTACH01?page=7&y=276&k=fig'],
    ['表 2', 'zotero://open-pdf/library/items/ATTACH01?page=16&y=80&k=tab'],
    ['算法 1', 'zotero://open-pdf/library/items/ATTACH01?page=6&y=269&k=alg'],
    ['p.3–4', 'zotero://open-pdf/library/items/ATTACH01?page=3'],
    ['p.9', 'zotero://open-pdf/library/items/ATTACH01?page=9'],
  ]);
  assert.match(html, /\[p\.99\]/); // beyond the last page: plain text
  assert.match(html, /<span class="math">\$p\.3\$<\/span>/);
  assert.ok(!/<a /.test(markdownToNote('见式 (11) [p.3]'))); // no paper to link to: plain text
});
