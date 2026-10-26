// Tools the model calls (no panel attached: a tool with a UI resource would open a new panel each time,
// spike S5). They read what the reader shows, read the paper, and write annotations through the same
// queue as the panel. The skill (skills/zotero-reader/SKILL.md) says when to use which.
import { z } from 'zod';
import { QA_TAG, colorInfo, qaEntry } from '../shared/annotations.mjs';
import { childNotes, getNote, noteSection, noteText } from './notes.mjs';
import { buildOutline, outlineText } from './outline.mjs';
import { questionsText } from './reading.mjs';

const KEY = z.string().regex(/^[A-Z0-9]{8}$/);
// Saved answers are notes to glance at while reading, not explanations (user: "保持注释的简短性…尽可能讲核心").
const MAX_ANSWER = 300;
const docArg = { docId: z.string().optional().describe('Reader document id; omit for the paper active in the reader.') };
// The user's palette is editable in the settings, so meanings are checked when the tool runs.
const meaning = z.string().max(30).describe("One of the user's annotation tags (default palette: 重点 yellow, 问答 purple, 定义 blue, 启发 green, 存疑 red; the user may have changed it).");
function colorOf(palette, tag) {
  const c = palette.find(e => e.tag === tag);
  if (!c) throw new Error(`没有名为"${tag}"的标签；当前可用：${palette.map(e => e.tag).join('、')}。`);
  return c.color;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const within = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms, null))]);

// One line per section (bookmarks to depth 1, else headings inferred from the layout), for paper_context.
function structureLines(o) {
  const marks = o.bookmarks.filter(b => b.depth <= 1 && b.page);
  const rows = marks.length >= 3 ? marks.map(b => `${'  '.repeat(b.depth)}${b.title}（第 ${b.page} 页）`)
    : o.sections.map(s => `${s.number ? `${s.number} ` : ''}${s.title}（第 ${s.page} 页）`);
  return rows.slice(0, 50);
}

const overlaps = (a, b) => a.some(([x, y, w, h]) => b.some(([X, Y, W, H]) => x < X + W && X < x + w && y < Y + H && Y < y + h));

function describe(a, palette) {
  const c = colorInfo(a.color, palette);
  const kind = { highlight: '高亮', underline: '下划线', image: '区域', note: '便签', ink: '手绘', text: '文字框' }[a.type] || a.type;
  const tags = a.tags.length ? ` #${a.tags.join(' #')}` : '';
  return `[${a.key}] 第 ${a.page} 页（页码 ${a.pageLabel}）${c ? c.tag : a.color} ${kind}${tags}${a.text ? `：「${clip(a.text, 300)}」` : ''}${a.comment ? `\n  评论：${clip(a.comment, 600)}` : ''}`;
}

// How alike two questions are: overlap of their character pairs, ignoring spacing and punctuation
// (works for Chinese and English alike). "为什么用 ATOA？" vs "为什么要用ATOA" ≈ 0.8.
const pairs = text => {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
export function similarity(a, b) {
  const A = pairs(a), B = pairs(b);
  if (!A.size || !B.size) return a.trim() === b.trim() ? 1 : 0;
  let common = 0;
  for (const p of A) if (B.has(p)) common++;
  return common / (A.size + B.size - common);
}
const SAME_QUESTION = 0.5;

// A new answer replaces the block of a similar question at the same place (the newer answer wins and the
// note stays short); a different question adds a block.
export function mergeQA(comment, block, question) {
  const blocks = comment ? comment.split(/\n{2,}/) : [];
  const asked = b => (b.match(/^问：(.*)/) || [])[1] || '';
  let best = -1, score = 0;
  blocks.forEach((b, i) => {
    const s = similarity(asked(b), question);
    if (s > score) [best, score] = [i, s];
  });
  if (best >= 0 && score >= SAME_QUESTION) blocks[best] = block;
  else blocks.push(block);
  return blocks.join('\n\n');
}

export function modelTools(ctx) {
  const { annotations, paper, state } = ctx;
  const palette = async () => (await state.prefs()).palette;

  return {
    reader_state: {
      description: 'What the user is reading right now in the Zotero reader panel: paper, page, visible pages, current selection, open tabs. Cheap; call it before answering a question about "this", "here" or "the selected part".',
      schema: {},
      async run() {
        const live = ctx.live();
        const view = ctx.view();
        const { tabs, active } = await ctx.tabsView();
        const tabLine = tabs.length ? `\n打开的标签：${tabs.map(t => `《${clip(t.title, 40)}》(${t.id})`).join('、')}` : '';
        // What the panel itself says it shows wins; the saved tabs are the fallback when it hasn't reported.
        const onNote = view?.kind === 'note' ? view.note : !view && active?.startsWith('note:') ? { key: active.slice(5), title: tabs.find(t => t.id === active)?.title } : null;
        if (onNote) {
          return { text: `面板上是 Zotero 笔记《${onNote.title ?? ''}》（笔记 key ${onNote.key}），不是论文原文；可用 read_notes 读取。${tabLine}`, data: { view: 'note', note: onNote, tabs } };
        }
        if (view?.kind === 'home' || !active) {
          return { text: `面板在首页（搜索与在读列表），没有打开论文。${tabLine}`, data: { view: 'home', tabs } };
        }
        const doc = await ctx.docById(live?.docId || active);
        const lines = [`正在读《${doc.title}》（docId ${doc.id}${doc.itemKey ? `，Zotero 条目 ${doc.itemKey}` : ''}），共 ${doc.pageCount} 页。`];
        if (live?.docId === doc.id) {
          lines.push(`当前第 ${live.page} 页，屏幕上是第 ${live.visible[0]}–${live.visible[1]} 页。`);
          if (live.selection?.kind === 'text') lines.push(`选中了第 ${live.selection.page} 页的文字：「${clip(live.selection.text, 1500)}」`);
          if (live.selection?.kind === 'region') lines.push(`框选了第 ${live.selection.page} 页的一块区域（多为公式或图），可用 annotate(use_selection) 存问答。`);
          const q = !live.selection && ctx.asked()?.docId === doc.id ? ctx.asked().selection : null;
          if (q) lines.push(`现在没有选区；用户上次用面板提问的是第 ${q.page} 页的${q.kind === 'text' ? `「${clip(q.text, 300)}」` : '一块框选区域'}，annotate(use_selection) 仍指向它。`);
        } else {
          lines.push('面板暂时没有报告位置（可能未打开）。');
        }
        return { text: lines.join('\n') + (tabs.length > 1 ? tabLine : ''), data: { view: 'paper', docId: doc.id, itemKey: doc.itemKey, live, tabs } };
      },
    },

    paper_context: {
      description: 'One call for answering a question about the paper being read: the current page and its neighbors as repaired text, the selection, and the annotations / earlier AI answers near there. Use this before read_pages; read other pages only when the answer needs them.',
      schema: { ...docArg, page: z.number().int().min(1).optional().describe('Center page; default: the page on screen.') },
      async run({ docId, page }) {
        const doc = await ctx.activeDoc(docId);
        const live = ctx.live();
        const here = live?.docId === doc.id ? live : null;
        const center = Math.min(doc.pageCount, page || here?.page || (await state.document(doc.id))?.position?.page || 1);
        const pages = await paper.read(doc, Math.max(1, center - 1), Math.min(doc.pageCount, center + 1));
        const { items } = await annotations.list(doc);
        const near = items.filter(a => Math.abs(a.page - center) <= 2);
        const out = [`《${doc.title}》（docId ${doc.id}${doc.itemKey ? `，Zotero 条目 ${doc.itemKey}` : ''}），共 ${doc.pageCount} 页；中心第 ${center} 页。`];
        // The map itself is read once per conversation (paper_map); here only a pointer to it.
        const [map, reading] = await Promise.all([within(ctx.maps.find(doc).catch(() => null), 1500), within(ctx.readingNotes.find(doc).catch(() => null), 1500)]);
        if (reading) out.push(`\n本篇有精读笔记（Zotero 笔记 ${reading.key}，已读完 ${reading.done.length} 个精读问题，最后整理于 ${reading.date || '未知'}），记着以前导读的结论；导读、或用户提到以前的讨论时用 reading_guide 读取。`);
        if (map) out.push(`\n本篇有论文地图（Zotero 笔记 ${map.key}，${map.model} 生成于 ${map.date}，状态：${map.status}）。本对话尚未读过的话，先调用 paper_map 读一次。`);
        else {
          // The structure is usually ready (built in the background after opening); don't wait long for it.
          const o = await within(buildOutline(doc, ctx).catch(() => null), 1500);
          const rows = o ? structureLines(o) : [];
          if (rows.length) out.push(`\n结构（图表与编号公式见 paper_outline）：\n${rows.join('\n')}`);
        }
        if (here?.selection?.kind === 'text') out.push(`\n用户选区（第 ${here.selection.page} 页）：「${clip(here.selection.text, 1500)}」`);
        if (here?.selection?.kind === 'region') out.push(`\n用户框选了第 ${here.selection.page} 页的一块区域（图或公式）。`);
        const pal = await palette();
        out.push(near.length ? `\n附近的批注与问答（共 ${items.length} 条中的 ${near.length} 条）：\n${near.map(a => describe(a, pal)).join('\n')}` : `\n附近没有批注（全文共 ${items.length} 条）。`);
        for (const p of pages) out.push(`\n=== 第 ${p.page} 页（页码 ${p.label}）===\n${p.text}`);
        return { text: out.join('\n'), data: { docId: doc.id, center, annotations: near.length } };
      },
    },

    paper_outline: {
      description: "The paper's structure: PDF bookmarks, section headings, figure and table captions, and numbered equations, each with its page. Use it to find which pages to read (e.g. where equation (12) or Section 3.2 is) instead of reading the whole paper. Built once per paper from the layout; it can miss or mislabel items.",
      schema: { ...docArg },
      async run({ docId }) {
        const doc = await ctx.activeDoc(docId);
        const o = await buildOutline(doc, ctx);
        return { text: outlineText(doc, o), data: { sections: o.sections.length, captions: o.captions.length, equations: o.equations.length } };
      },
    },

    paper_map: {
      description: "The paper's map: a Zotero note \"论文地图\" written by a model from the full text — one-line summary, problem and contributions, section structure, key concepts and symbols, method, main results, assumptions and limitations, each with page numbers. Read it once per conversation, the first time a question is about this paper, then don't read it again. It is for finding your way (which pages to read), not a source: check the pages before relying on it.",
      schema: { ...docArg },
      async run({ docId }) {
        const doc = await ctx.activeDoc(docId);
        const job = ctx.maps.status(doc);
        const map = await ctx.maps.read(doc);
        if (!map) {
          const note = job.status === 'running' ? '论文地图正在生成，通常需要一两分钟。' : '这篇论文还没有论文地图（用户要求时才生成）。';
          return { text: `${note}按需使用 paper_outline、find_in_paper 与 read_pages。`, data: { exists: false, job } };
        }
        const warn = map.stale ? '（注意：地图是为另一版本的 PDF 生成的，页码可能对不上。）\n' : '';
        return { text: `${warn}${map.text}`, data: { exists: true, key: map.key, stale: map.stale, status: map.status } };
      },
    },

    paper_map_generate: {
      description: 'Generate (or regenerate) the paper map in the background with gpt-6.1-sol and save it as the Zotero note "论文地图". Only when the user explicitly asks for it: it sends the paper\'s full text to the cloud model and takes a minute or two. Returns at once; read it later with paper_map.',
      schema: { ...docArg },
      async run({ docId }) {
        const doc = await ctx.activeDoc(docId);
        const job = ctx.maps.start(doc);
        return { text: job.status === 'running' ? '已开始生成论文地图，约一两分钟后写入 Zotero 笔记"论文地图"；完成后可用 paper_map 读取。' : `地图状态：${job.status}`, data: job };
      },
    },

    reading_guide: {
      description: "Guided reading: the user's reading questions in full (the lens to read this paper with — all answered, the paper is read), which of them are already worked through, and the paper's reading note (\"精读笔记\") so far. Call it once when the user asks to be led through the paper (带我读), and before reading_note_save; also when the user refers to conclusions of an earlier guided reading.",
      schema: { ...docArg },
      async run({ docId }) {
        const doc = await ctx.activeDoc(docId);
        const r = await ctx.readingNotes.read(doc);
        const head = `精读问题（共 ${r.count} 问，已读完 ${r.done.length} 问）：\n${questionsText(r.tpl, r.done)}`;
        const body = r.note ? `\n\n精读笔记（Zotero 笔记 ${r.note.key}，最后整理于 ${r.note.date || '未知'}）：\n${r.text}` : '\n\n这篇论文还没有精读笔记。';
        return { text: head + body, data: { exists: !!r.note, key: r.note?.key ?? null, questions: r.count, done: r.done } };
      },
    },

    reading_note_save: {
      description: 'Update the paper\'s reading note (one Zotero note per paper, "精读笔记") during guided reading: after a reading question has been worked through with the user, write what was understood and mark the question done. Also when the user asks to keep a discussion as a note. Call reading_guide first in the conversation. sections: the parts of the note to write, each a title and Markdown content; a section with the same title is replaced (merge what it already says), a new title is added at the end, empty content removes it; sections not sent stay as they are. Organise the note your way — by the line of reasoning the reading followed, not one section per question; keep what matters (the problem, why earlier attempts fail, the author\'s idea, the method, what the experiments show, the user\'s own ideas marked "（我）"), with page references [p.N]. done: numbers of the reading questions now worked through.',
      schema: {
        ...docArg,
        sections: z.array(z.object({ title: z.string().max(100), content: z.string().describe('Markdown; formulas as $…$, page references as [p.N].') })).max(20).optional(),
        done: z.array(z.number().int().min(1)).max(40).optional().describe('Reading questions now worked through.'),
      },
      async run({ docId, sections = [], done = [] }) {
        const doc = await ctx.activeDoc(docId);
        const r = await ctx.readingNotes.save(doc, { sections, done });
        const text = `${r.created ? '已新建' : '已更新'}精读笔记（Zotero 笔记 ${r.key}）。`
          + `${r.remaining.length ? `已读完 ${r.done.length} 问；未读到：第 ${r.remaining.join('、')} 问。` : '精读问题已全部读完。'}`;
        return { text, data: { key: r.key, created: r.created, done: r.done, remaining: r.remaining } };
      },
    },

    read_pages: {
      description: 'Repaired text of pages from..to of the paper (ligatures and symbols fixed; formulas may still be garbled — ask the user to box-select a formula for an image if it matters). At most about 40k characters per call.',
      schema: { ...docArg, from: z.number().int().min(1), to: z.number().int().min(1).optional() },
      async run({ docId, from, to }) {
        const doc = await ctx.activeDoc(docId);
        const pages = await paper.read(doc, from, to ?? from);
        const text = pages.map(p => (p.truncated ? `=== 第 ${p.page} 页起未返回（超出单次上限，请分次读取）===` : `=== 第 ${p.page} 页（页码 ${p.label}）===\n${p.text}`)).join('\n\n');
        return { text: `《${doc.title}》\n\n${text}`, data: { pages: pages.map(p => p.page) } };
      },
    },

    find_in_paper: {
      description: 'Find a word or phrase in the paper; returns pages and short snippets. Case-insensitive; spacing and line-end hyphenation are ignored.',
      schema: { ...docArg, query: z.string().min(1).max(200) },
      async run({ docId, query }) {
        const doc = await ctx.activeDoc(docId);
        const hits = await paper.find(doc, query);
        return { text: hits.length ? hits.map(h => `第 ${h.page} 页：${h.snippet}`).join('\n') : `没有找到「${query}」。`, data: { count: hits.length } };
      },
    },

    list_annotations: {
      description: "The paper's Zotero annotations and earlier AI answers (tag AI问答), in reading order, optionally filtered.",
      schema: { ...docArg, meaning: meaning.optional(), tag: z.string().optional(), page: z.number().int().min(1).optional() },
      async run({ docId, meaning: m, tag, page }) {
        const doc = await ctx.activeDoc(docId);
        const { items, error } = await annotations.list(doc);
        const pal = await palette();
        const want = m ? colorOf(pal, m) : null;
        const shown = items.filter(a => (!want || a.color === want || a.tags.includes(m)) && (!tag || a.tags.includes(tag)) && (!page || a.page === page));
        const text = shown.length ? shown.map(a => describe(a, pal)).join('\n') : '没有符合条件的批注。';
        return { text: `${error ? `（${error}，以下为上次读到的批注）\n` : ''}${text}`, data: { count: shown.length } };
      },
    },

    annotate: {
      description: 'Create a Zotero annotation on the paper, written in the background (Zotero may ask the user once to allow writing). Locate it by an exact quote from the paper (with page if known) or use the user\'s current selection. To save an answer to a question about a specific place, pass question and answer: it becomes a highlight in the color of the user\'s 问答 tag (purple if there is none) tagged AI问答, whose comment is "问：…\\n答：…"; a second answer at the same place updates that annotation instead of adding one.',
      schema: {
        ...docArg,
        quote: z.string().max(4000).optional().describe('Exact text from the paper (a sentence or phrase) to annotate.'),
        page: z.number().int().min(1).optional(),
        use_selection: z.boolean().optional().describe('Annotate what the user has selected in the reader (text or a boxed region).'),
        meaning: meaning.optional(),
        underline: z.boolean().optional(),
        comment: z.string().max(10000).optional(),
        question: z.string().max(1000).optional(),
        answer: z.string().max(4000).optional().describe(`The core of the answer only: one or two sentences (about 100 Chinese characters, at most ${MAX_ANSWER}), with page references. No restating the question, no background.`),
      },
      async run({ docId, quote, page, use_selection: useSelection, meaning: m, underline, comment = '', question, answer }) {
        const doc = await ctx.activeDoc(docId);
        let sel;
        if (useSelection) {
          // The live selection, else the one the user asked about with the panel's 提问 button.
          const s = (ctx.live()?.docId === doc.id && ctx.live().selection) || (ctx.asked()?.docId === doc.id ? ctx.asked().selection : null);
          if (!s) throw new Error('用户当前没有选区；请改用 quote 指定原文。');
          sel = s.kind === 'region' ? { kind: 'region', page: s.page, rects: [s.rect] } : { kind: 'text', page: s.page, rects: s.rects, text: s.text, offset: s.a };
        } else {
          if (!quote) throw new Error('需要 quote（原文引文）或 use_selection。');
          const at = await paper.locate(doc, quote, page);
          sel = { kind: 'text', page: at.page, rects: at.rects, text: at.text, offset: at.a };
        }
        const qa = question && answer;
        if (qa && answer.trim().length > MAX_ANSWER) {
          throw new Error(`answer 太长（${answer.trim().length} 字）：批注只记核心，请压缩成一两句（约 100 字）后重试；完整解释留在对话里。`);
        }
        const pal = await palette();
        const color = qa ? qaEntry(pal).color : m ? colorOf(pal, m) : pal[0].color;
        if (qa) {
          comment = `问：${question.trim()}\n答：${answer.trim()}`;
          const { items } = await annotations.list(doc);
          const same = items.find(a => a.tags.includes(QA_TAG) && a.page === sel.page && overlaps(a.rects, sel.rects));
          if (same) {
            await annotations.update(doc, same.key, { comment: mergeQA(same.comment, comment, question.trim()) });
            return { text: `已把问答并入第 ${sel.page} 页已有的问答批注 ${same.key}。`, data: { key: same.key, updated: true } };
          }
        }
        const key = await annotations.create(doc, sel, { color, type: underline ? 'underline' : 'highlight', comment, tags: qa ? [QA_TAG] : [] });
        const what = sel.kind === 'region' ? '框选区域' : `「${clip(sel.text, 80)}」`;
        return { text: `已在第 ${sel.page} 页建立批注 ${key}（${colorInfo(color, pal)?.tag ?? color}${qa ? ' · AI问答' : ''}）：${what}。正在后台写入 Zotero。`, data: { key, page: sel.page } };
      },
    },

    update_annotation: {
      description: "Change an annotation's comment or meaning (color + meaning tag). Edits made in Zotero meanwhile are never overwritten.",
      schema: { ...docArg, key: KEY, comment: z.string().max(10000).optional(), meaning: meaning.optional() },
      async run({ docId, key, comment, meaning: m }) {
        const doc = await ctx.activeDoc(docId);
        await annotations.update(doc, key, { comment, color: m ? colorOf(await palette(), m) : undefined });
        return { text: `已更新批注 ${key}。`, data: { key } };
      },
    },

    delete_annotation: {
      description: 'Delete an annotation from Zotero (for good, as Zotero itself does; the user can undo with ⌘Z in the reader). Only when the user asks.',
      schema: { ...docArg, key: KEY },
      async run({ docId, key }) {
        const doc = await ctx.activeDoc(docId);
        await annotations.remove(doc, key);
        return { text: `已删除批注 ${key}（在阅读器中按 ⌘Z 可恢复）。`, data: { key } };
      },
    },

    show_location: {
      description: 'Scroll the open reader to a place and outline it briefly: an exact quote, an annotation key, or a page. Use it when pointing the user to where something is said.',
      schema: { ...docArg, quote: z.string().max(4000).optional(), key: KEY.optional(), page: z.number().int().min(1).optional() },
      async run({ docId, quote, key, page }) {
        const doc = await ctx.activeDoc(docId);
        let target = { page: page || 1, rects: null };
        if (key) {
          const a = (await annotations.list(doc)).items.find(x => x.key === key);
          if (!a) throw new Error('找不到这条批注。');
          target = { page: a.page, rects: a.rects, key };
        } else if (quote) {
          const at = await paper.locate(doc, quote, page);
          target = { page: at.page, rects: at.rects };
        }
        if (target.page > doc.pageCount) throw new Error(`页码超出范围（1–${doc.pageCount}）。`);
        const live = await ctx.navigate(doc, target);
        return { text: `已在阅读器中跳到第 ${target.page} 页。${live ? '' : '（阅读器面板似乎没有打开；可调用 reader_open 打开后再跳转。）'}`, data: target };
      },
    },

    read_notes: {
      description: "The paper's Zotero notes (the user's own and AI-written ones). Without key: the list of notes with their headings. With key: the note as text (formulas as TeX), or only the section whose heading contains `section`. Notes are not the paper: check page references against the paper before relying on them.",
      schema: { ...docArg, key: KEY.optional(), section: z.string().max(200).optional() },
      async run({ docId, key, section }) {
        if (key) {
          const n = await getNote(key);
          const text = noteText(n.html);
          const part = section ? noteSection(text, section) : text;
          if (part === null) throw new Error(`笔记中没有标题含「${section}」的部分。`);
          return { text: clip(part, 30000), data: { key, chars: part.length } };
        }
        const doc = await ctx.activeDoc(docId);
        const notes = doc.itemKey ? await childNotes(doc.itemKey) : [];
        if (!notes.length) return { text: '这篇论文没有 Zotero 笔记。', data: { notes } };
        const out = [];
        for (const n of notes) {
          const heads = noteText((await getNote(n.key)).html).split('\n').filter(l => /^#{1,3} /.test(l)).slice(0, 20);
          out.push(`[${n.key}] ${n.title}${heads.length ? `\n  ${heads.join('\n  ')}` : ''}`);
        }
        return { text: out.join('\n'), data: { notes } };
      },
    },

    search_annotations: {
      description: "Search the user's annotations and saved AI answers across all papers in the Zotero library (highlighted text, comments, tags). Use it to connect the current paper with what the user marked or asked about elsewhere. Returns each match with its paper's item key (open with reader_open).",
      schema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() },
      async run({ query, limit }) {
        const pal = await palette();
        const hits = await ctx.searchAnnotations(query, limit || 20);
        if (!hits.length) return { text: `没有找到含「${query}」的批注。`, data: { count: 0 } };
        const byPaper = new Map();
        for (const h of hits) {
          const k = h.paper.key || h.paper.attachmentKey;
          if (!byPaper.has(k)) byPaper.set(k, { paper: h.paper, hits: [] });
          byPaper.get(k).hits.push(h);
        }
        const text = [...byPaper.values()].map(({ paper, hits: hs }) => `《${clip(paper.title, 90)}》（条目 ${paper.key ?? '?'}）\n${hs.map(h => {
          const c = colorInfo(h.color, pal);
          return `  [${h.key}] 页码 ${h.page} ${c ? c.tag : h.color}${h.tags.length ? ` #${h.tags.join(' #')}` : ''}${h.text ? `「${clip(h.text, 200)}」` : ''}${h.comment ? `\n    评论：${clip(h.comment, 300)}` : ''}`;
        }).join('\n')}`).join('\n\n');
        return { text, data: { count: hits.length, papers: byPaper.size } };
      },
    },

    page_layout: {
      description: 'Read page blocks (paragraphs, formulas, tables, figures). Uses complete cached MinerU geometry/text when available, otherwise local detection. Never starts OCR.',
      schema: { ...docArg, page: z.number().int().min(1) },
      async run({ docId, page }) { const doc = await ctx.activeDoc(docId); const data = await ctx.analysis.layout(doc, page); return { data, text: JSON.stringify(data) }; },
    },
    ocr_status: {
      description: 'Read whole-document OCR progress, full-text version/availability and global OCR permission. Does not upload or start OCR.',
      schema: docArg,
      async run({ docId }) { const data = await ctx.analysis.status(await ctx.activeDoc(docId)); return { data, text: JSON.stringify(data) }; },
    },
    ocr_start: {
      description: 'Start whole-document MinerU OCR in the background. Reuses an existing complete result or active job; never re-uploads those. With userRequested=false, allowed when the global allowModelOcr setting is enabled (default with a configured key). Set userRequested=true only for an explicit user request to recognize/upload this paper. Use ocr_status for progress, paper_full_text after completion. Do not start OCR merely because the paper was opened.',
      schema: { ...docArg, userRequested: z.boolean().default(false).describe('True only for an explicit request from the user to OCR this paper.') },
      async run({ docId, userRequested = false }) {
        const doc = await ctx.activeDoc(docId);
        const status = await ctx.analysis.status(doc);
        const active = status.job && !['done', 'failed', 'cancelled'].includes(status.job.state);
        if (!status.complete && !active && !userRequested && !status.settings.allowModelOcr) {
          return { data: { ...status, blocked: true }, text: '模型按需识别当前不可用。请先在全局设置中配置 MinerU API key 并开启“允许模型按需识别”。没有上传文件。' };
        }
        const data = await ctx.analysis.start(doc);
        return { data, text: data.complete ? '完整 MinerU 结果已缓存，无需重复识别。用 paper_full_text 按需读取。' : '整篇 OCR 任务运行中；用 ocr_status 查询，完成后用 paper_full_text 读取。' };
      },
    },
    paper_full_text: {
      description: 'Read cached complete MinerU full text into this conversation, with original PDF page numbers. Never starts OCR. Fetch only when the current question needs full-paper context; otherwise use the selection or relevant pages. Read a document/version only once per conversation; reuse that tool result on later turns. If this version is ALREADY fully present in your current conversation, skip the call or pass knownVersion to return metadata only. For long papers follow nextOffset with the returned version until null; only then is that version fully read. No cross-conversation deduplication. After context loss, omit knownVersion to retrieve again. If unavailable use read_pages or explicitly permitted ocr_start.',
      schema: { ...docArg, knownVersion: z.string().optional().describe('Version already fully read in THIS conversation; suppresses duplicate body.'), version: z.string().optional().describe('Expected version for pagination; stops mixing revisions.'), offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(1).max(60000).default(40000) },
      async run({ docId, ...options }) {
        const { text, ...data } = await ctx.analysis.fullText(await ctx.activeDoc(docId), options);
        return { data, text };
      },
    },
    search_library: {
      description: 'Search the Zotero library by title, author and year. Returns item keys to open with reader_open.',
      schema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(30).optional() },
      async run({ query, limit }) {
        const items = await ctx.searchLibrary(query, limit || 10);
        return { text: items.length ? items.map(i => `${i.key}  ${i.creators} ${i.year}  ${i.title}`).join('\n') : '没有找到。', data: { items } };
      },
    },
  };
}
