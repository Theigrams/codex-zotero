import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationRef, noteSection, noteText, noteTitle, renderNote } from '../src/server/notes.mjs';

const note = `<div data-schema-version="9"><h1>精读笔记</h1>
<p onclick="alert(1)" style="color:red">见 <span class="math">$\\mathbf{T}_{ij} &lt; 1$</span> 与图。<script>alert(2)</script></p>
<pre class="math">$$\\int_0^1 f(x)\\,\\mathrm{d}x$$</pre>
<h2>方法</h2><p>二次规划 <a href="javascript:alert(3)">x</a> <a href="https://example.org">链接</a></p>
<p><img data-attachment-key="IMAGE001" alt="fig"></p>
<p><span class="highlight" data-annotation="${encodeURIComponent(JSON.stringify({ attachmentURI: 'http://zotero.org/users/local/abc/items/ATTACH01', annotationKey: 'ANNO0001', position: { pageIndex: 2, rects: [[1, 2, 3, 4]] } }))}">“quoted text”</span></p>
<h2>局限</h2><table><tr><td>a</td><td>b</td></tr></table></div>`;

test('notes are sanitized, formulas are typeset with KaTeX, headings get ids, images are inlined', async () => {
  const { html, toc } = await renderNote(note, { loadImage: async k => (k === 'IMAGE001' ? 'data:image/png;base64,AAAA' : null) });
  assert.ok(!/script|onclick|color:red|javascript:/.test(html), html);
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /class="katex-display"/);
  assert.ok(!html.includes('<math'), 'HTML only: the panel carries KaTeX fonts');
  assert.match(html, /<a href="https:\/\/example.org">/);
  assert.match(html, /<img src="data:image\/png;base64,AAAA"/);
  assert.match(html, /data-annotation=/);
  assert.deepEqual(toc.map(t => [t.level, t.text, t.id]), [[1, '精读笔记', 'h-0'], [2, '方法', 'h-1'], [2, '局限', 'h-2']]);
  const missing = await renderNote('<p><img data-attachment-key="NOPE0001"></p>', { loadImage: async () => null });
  assert.match(missing.html, /图片未能载入/);
});

test('note text for the model keeps headings, formulas and table cells; sections can be cut out', () => {
  const text = noteText(note);
  assert.match(text, /^# 精读笔记/);
  assert.match(text, /\$\\mathbf\{T\}_\{ij\} < 1\$/);
  assert.match(text, /\$\$\\int_0\^1/);
  assert.match(text, /\| a \| b/);
  assert.equal(noteSection(text, '方法').split('\n')[0], '## 方法');
  assert.ok(!noteSection(text, '方法').includes('局限'));
  assert.equal(noteTitle(note), '精读笔记');
});

test('highlights quoted in notes point back to the PDF', () => {
  const enc = encodeURIComponent(JSON.stringify({ attachmentURI: 'http://zotero.org/users/1/items/ATTACH01', position: { pageIndex: 4, rects: [[1, 2, 3, 4]] } }));
  assert.deepEqual(annotationRef(enc), { attachmentKey: 'ATTACH01', annotationKey: null, pageIndex: 4, rects: [[1, 2, 3, 4]] });
  assert.equal(annotationRef('%%%'), null);
});

test('page references read as page tags in the panel; other brackets stay', async () => {
  const link = p => `<a href="zotero://open-pdf/library/items/ATTACH01?page=${p}">p.${p}</a>`;
  const { html } = await renderNote(`<p>结论。[${link(3)}, ${link(9)}] 见 <a href="zotero://open-pdf/library/items/ATTACH01?page=8&amp;k=eq">式 (11)</a>；区间 [0, 1]；[${link(4)}, 附录]</p>`);
  assert.match(html, /结论。<span class="pages"><a href="zotero:[^"]*page=3">p\.3<\/a><a href="zotero:[^"]*page=9">p\.9<\/a><\/span>/);
  assert.match(html, /见 <a href="zotero:[^"]*k=eq">式 \(11\)<\/a>/);
  assert.match(html, /区间 \[0, 1\]/);
  assert.match(html, /\[<a [^>]*>p\.4<\/a>, 附录\]/, 'brackets holding other text are left alone');
});

test('only the first line of a note Codex wrote reads as a quiet line', async () => {
  assert.match((await renderNote('<h1>论文地图：X</h1><p>AI 生成的论文地图 · 模型 m</p><p>正文</p>')).html, /<p class="meta">AI 生成的论文地图/);
  assert.match((await renderNote('<h1>精读笔记：X</h1>\n<p>Codex 根据导读对话整理 · 最后整理 2026-10-24</p>')).html, /<p class="meta">Codex 根据/);
  assert.ok(!(await renderNote('<h1>我的笔记</h1><p>能量很重要</p>')).html.includes('class="meta"'), 'the user\'s own notes are left alone');
});
