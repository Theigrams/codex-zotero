// The reading questions: the lens Codex reads a paper with when it guides the
// user through it; all of them answered, the paper is read. Editable in the settings drawer.
// Format: "## " starts a group; "### " starts a question (its short title), and the lines under it are the
// question in full. A group without questions is opened up by the discussion; its text tells how.
// The questions keep the user's wording: every requirement in them is part of reading the paper well.

export const DEFAULT_QUESTIONS = `## 一、问题与背景

### 研究问题与价值
论文提出并解决了什么研究问题（补充必要的调研与背景）？这个问题为什么重要？解决它能带来哪些价值？

### 关键人物与实验室
这个方向有哪些关键人物和实验室（包括本文作者团队）？各自的代表性工作与技术路线是什么？

### 已有研究的不足
这个问题此前是否已被解决？已有研究存在哪些不足，原因是什么？

## 二、思路与方法

### 【重要】作者的思考路径
不以本文的贡献为前提，只依据此前已有的背景、失败模式、经验观察和相关工作，重建作者可能的思考路径：作者受到了哪些启发（inspiration），凭借怎样的直觉（intuition），为什么能从已有知识出发想到这个 idea？

### 核心直觉
方法的 intuition 是什么？核心 idea 的本质是什么？用清晰、简洁、易懂的话说清。

### 具体方法
方法具体如何运作？结合一个真实例子，走一遍从输入、处理到输出的完整流程（pipeline）。

### 核心数学推导
方法背后的核心推导是什么？讲到数学基础薄弱的人也能从理论角度理解方法，并补充所需的理论背景，讲清理论基础和直觉。论文若没有核心推导，注明后跳过。

## 三、验证

### 实验如何验证主张
论文如何设计实验来验证方法和各项主张？逐条按"提出了什么问题 → 设计了什么实验 → 得到了什么答案"总结，只写核心思路，不堆数据细节。

### Take-aways
这篇论文最值得带走的要点有哪些？

## 四、批判与延伸
不设固定问题：读完前面的问题后，一起找论文最脆弱的假设、可能的反例、能做的最小复现，以及作者没想到的地方和更好的方法。
`;

const MAX_TEMPLATE = 20000;

// → { groups: [{ title, note, questions: [{ n, title, text }] }], count }; n counts the fixed questions from 1.
export function parseTemplate(source) {
  const text = String(source || '').replace(/\r/g, '');
  if (text.length > MAX_TEMPLATE) throw new Error(`精读问题太长（最多 ${MAX_TEMPLATE} 字）。`);
  const groups = [];
  let group = null, question = null, n = 0;
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^##\s+(.+)$/)) && !line.startsWith('###')) {
      group = { title: m[1].trim(), note: '', questions: [] };
      groups.push(group);
      question = null;
    } else if ((m = line.match(/^###\s+(.+)$/))) {
      if (!group) throw new Error('问题（### 开头）前要有分组（## 开头）。');
      question = { n: ++n, title: m[1].trim(), text: '' };
      group.questions.push(question);
    } else if (line.trim()) {
      if (question) question.text += (question.text ? '\n' : '') + line.trim();
      else if (group) group.note += (group.note ? '\n' : '') + line.trim();
    }
  }
  if (!groups.length) throw new Error('至少要有一个分组（## 开头）。');
  const titles = groups.flatMap(g => g.questions.map(q => q.title));
  if (new Set(titles).size !== titles.length) throw new Error('问题标题不能重复。');
  for (const q of groups.flatMap(g => g.questions)) if (!q.text) q.text = q.title;
  return { groups, count: n };
}
