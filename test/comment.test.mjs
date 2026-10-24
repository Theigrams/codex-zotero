import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentHTML, hasMarkup } from '../src/panel/mathtext.js';

test('comments render basic Markdown', () => {
  assert.equal(commentHTML('**粗体** 与 *斜体*，`code` 和 ~~删除~~'), '<p><strong>粗体</strong> 与 <em>斜体</em>，<code>code</code> 和 <s>删除</s></p>');
  assert.equal(commentHTML('这是*重点*文字'), '<p>这是<em>重点</em>文字</p>');
  assert.equal(commentHTML('- 一\n- 二\n\n1. 甲\n2. 乙'), '<ul><li>一</li><li>二</li></ul><ol><li>甲</li><li>乙</li></ol>');
  assert.equal(commentHTML('> 引文\n正文'), '<blockquote>引文</blockquote><p>正文</p>');
  assert.equal(commentHTML('## 小结\n问：为什么？\n答：因为。'), '<p class="h">小结</p><p>问：为什么？<br>答：因为。</p>');
  assert.equal(commentHTML('见 [论文](https://example.org/a?b=1&c=2)'), '<p>见 <a href="https://example.org/a?b=1&amp;c=2">论文</a></p>');
  assert.equal(commentHTML('snake_case_name 不变'), '<p>snake_case_name 不变</p>');
});

test('comments never inject markup, and formulas are not read as Markdown', () => {
  assert.equal(commentHTML('<img src=x onerror=alert(1)> [x](javascript:alert(1))'), '<p>&lt;img src=x onerror=alert(1)&gt; [x](javascript:alert(1))</p>');
  const html = commentHTML('乘积 $a*b*c$ 与 **加粗**');
  assert.equal((html.match(/class="katex"/g) || []).length, 1);
  assert.ok(!html.includes('<em>'), html);
  assert.ok(html.includes('<strong>加粗</strong>'));
  assert.ok(commentHTML('$$\\int_0^1 x\\,\\mathrm{d}x$$').includes('class="katex-display"'));
  assert.equal(commentHTML('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
});

test('live preview only when there is something to render', () => {
  assert.ok(hasMarkup('**a**') && hasMarkup('- item') && hasMarkup('$x$') && hasMarkup('[a](https://x.y)'));
  assert.ok(!hasMarkup('普通的评论，没有标记') && !hasMarkup('a - b'));
});
