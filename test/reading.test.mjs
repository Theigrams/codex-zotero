import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUESTIONS, parseTemplate } from '../src/server/reading-questions.mjs';
import { buildNote, questionsText, splitNote } from '../src/server/reading.mjs';
import { State } from '../src/server/state.mjs';

const tpl = parseTemplate(DEFAULT_QUESTIONS);
const refs = { attachmentKey: 'ATTACH01', pageCount: 20, outline: { equations: [{ label: '11', page: 8, y: 300, x: 100 }], captions: [] } };
const opts = { title: 'Paper <A>', date: '2026-10-24', refs };

test('the default reading questions: nine in full, and an open group for criticism and beyond', () => {
  assert.equal(tpl.count, 9);
  assert.deepEqual(tpl.groups.map(g => g.questions.length), [3, 4, 2, 0]);
  const qs = tpl.groups.flatMap(g => g.questions);
  assert.deepEqual(qs.slice(0, 3).map(q => q.title), ['研究问题与价值', '关键人物与实验室', '已有研究的不足']);
  assert.match(qs[3].text, /不以本文的贡献为前提.*失败模式.*inspiration.*intuition/);
  assert.match(qs[5].text, /结合一个真实例子.*输入、处理到输出/);
  assert.match(qs[7].text, /提出了什么问题 → 设计了什么实验 → 得到了什么答案/);
  assert.match(tpl.groups[3].note, /最脆弱的假设.*反例.*最小复现.*更好的方法/);
  assert.match(questionsText(tpl, ['核心直觉']), /第 5 问 核心直觉（已读完）：方法的 intuition/);
});

test('questions need groups and distinct titles', () => {
  assert.throws(() => parseTemplate('### 无分组的问题'), /分组/);
  assert.throws(() => parseTemplate('只有文字'), /至少要有一个分组/);
  assert.throws(() => parseTemplate('## A\n### 问题\n## B\n### 问题'), /不能重复/);
  const t = parseTemplate('## 只有一组\n### 一句话\n用一句话概括。');
  assert.equal(t.count, 1);
  assert.equal(t.groups[0].questions[0].text, '用一句话概括。');
});

test('a new note: sections as Codex organises them, links, and the reading progress at the end', () => {
  const r = buildNote(tpl, null, {
    sections: [
      { title: '问题从哪里来', content: '五轴加工中刀轴经过奇异点时转角剧变 [p.1]。\n\n## 为什么重要\n影响表面质量。' },
      { title: '作者的想法', content: '在奇异圆附近改写刀轴，见式 (11) [p.8]，$R = \\gamma r$。（我）缓冲区宽度缺少依据。' },
    ],
    done: [1, 4],
  }, opts);
  assert.deepEqual(r.done, [1, 4]);
  assert.deepEqual(r.remaining, [2, 3, 5, 6, 7, 8, 9]);
  assert.match(r.html, /<h1>精读笔记：Paper &lt;A&gt;<\/h1>/);
  assert.match(r.html, /Codex 根据导读对话整理 · 最后整理 2026-10-24/);
  assert.match(r.html, /<h2>问题从哪里来<\/h2>\n<p>五轴加工中/);
  assert.match(r.html, /<h3>为什么重要<\/h3>/, 'headings inside a section sit below it');
  assert.match(r.html, /href="zotero:\/\/open-pdf\/library\/items\/ATTACH01\?page=8&amp;y=300&amp;x=100&amp;k=eq"/);
  assert.match(r.html, /<h2>阅读进度<\/h2>\n<ul><li>已读完：第 1 问 研究问题与价值；第 4 问 【重要】作者的思考路径<\/li><li>未读到：第 2 问 关键人物与实验室；/);
  assert.ok(!r.html.includes('<blockquote>'), 'the note does not copy the questions');
});

test('updating: sections replaced or added by title; untouched ones keep their Zotero HTML; progress accumulates', () => {
  const first = buildNote(tpl, null, { sections: [{ title: '问题', content: '旧。' }, { title: '方法', content: '旧方法。' }, { title: '待删', content: 'x' }], done: [1] }, opts);
  // The user edited a section in Zotero, quoting a highlight; Zotero wrapped the note its own way.
  const edited = first.html.replace('<p>旧方法。</p>', '<p>旧方法，<span class="highlight" data-annotation="%7B%7D">“原文”</span>。</p>');
  const parsed = splitNote(edited);
  assert.deepEqual(parsed.done, ['研究问题与价值']);
  assert.deepEqual(parsed.sections.map(s => s.title), ['问题', '方法', '待删']);
  const second = buildNote(tpl, parsed, {
    sections: [{ title: '问题', content: '新的理解 [p.2]。' }, { title: '待删', content: '' }, { title: '实验说明了什么', content: '检测快约 39 倍 [p.11]。' }],
    done: [8, 1],
  }, { ...opts, date: '2026-10-25' });
  assert.match(second.html, /<h2>问题<\/h2>\n<p>新的理解/);
  assert.ok(!second.html.includes('旧。'));
  assert.match(second.html, /<p>旧方法，<span class="highlight" data-annotation="%7B%7D">“原文”<\/span>。<\/p>/);
  assert.ok(!second.html.includes('待删'));
  assert.ok(second.html.indexOf('实验说明了什么') > second.html.indexOf('<h2>方法</h2>'), 'a new section goes at the end');
  assert.deepEqual(second.done, [1, 8]);
  assert.equal((second.html.match(/<h2>阅读进度<\/h2>/g) || []).length, 1);
  assert.match(second.html, /最后整理 2026-10-25/);
  // Nothing changed: the note stays the same.
  assert.equal(buildNote(tpl, splitNote(second.html), {}, { ...opts, date: '2026-10-25' }).html, second.html);
  // All done.
  const all = buildNote(tpl, splitNote(second.html), { done: [2, 3, 4, 5, 6, 7, 9] }, opts);
  assert.deepEqual(all.remaining, []);
  assert.match(all.html, /<li>全部问题已读完。<\/li>/);
  assert.deepEqual(splitNote(all.html).done.length, 9);
});

test('the reading questions are a preference; broken ones are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-reading-'));
  try {
    const state = new State(root);
    assert.equal((await state.prefs()).readingQuestions, '');
    await state.setPrefs({ readingQuestions: '## 读后\n### 一句话\n概括。' });
    assert.match((await state.prefs()).readingQuestions, /一句话/);
    await assert.rejects(state.setPrefs({ readingQuestions: '### 没有分组' }), /分组/);
    await state.setPrefs({ readingQuestions: '' });
    assert.equal((await state.prefs()).readingQuestions, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
