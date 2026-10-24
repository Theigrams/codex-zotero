// Comments: basic Markdown plus formulas. Formulas ($…$, $$…$$, \(…\), \[…\]) are typeset with KaTeX, as in
// notes and in Zotero itself (its fonts are bundled into the panel by build.mjs). Markdown covers what fits in a comment: **bold**, *italic*,
// `code`, ~~strike~~, [links](https://…), "- " / "1. " lists, "> " quotes and "#" headings. The source is
// escaped first and only these constructs are turned into tags, so a comment can never inject markup.
import katex from 'katex';

const MATH = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
const SLOT = /\u0000(\d+)\u0000/g; // where a formula or code span sits while the text around it is processed

function formula(src) {
  const display = src.startsWith('$$') || src.startsWith('\\[');
  const tex = display ? src.slice(2, -2) : src.startsWith('$') ? src.slice(1, -1) : src.slice(2, -2);
  try {
    return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'html' });
  } catch {
    return null;
  }
}

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const hasMath = text => MATH.test(text) && !(MATH.lastIndex = 0);

// Worth a live preview while editing: formulas or Markdown marks.
export const hasMarkup = text => hasMath(text) || /\*\*|__|`|~~|\]\(|(^|\s)[*_]\S|^\s*([-*+]|\d{1,3}[.)]|>|#{1,6})\s/m.test(text);

// Inline Markdown on escaped text (formulas and code are already in slots).
function inline(s) {
  return s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>') // also inside CJK text: 这是*重点*
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<s>$1</s>');
}

export function commentHTML(text) {
  const slots = [];
  const keep = html => `\u0000${slots.push(html) - 1}\u0000`;
  // Formulas first (their TeX must not be read as Markdown), then code spans.
  let src = text.replace(MATH, m => keep(formula(m) ?? escape(m)));
  src = src.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escape(code)}</code>`));
  src = escape(src);

  const out = [];
  let list = null; // { tag, items }
  let quote = [];
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flush = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of src.split('\n')) {
    let m;
    if (!line.trim()) {
      flush();
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/))) {
      const tag = m.length === 3 ? 'ol' : 'ul';
      flushPara();
      flushQuote();
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(m[m.length - 1]);
    } else if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
      flushPara();
      flushList();
      quote.push(m[1]);
    } else if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) {
      flush();
      out.push(`<p class="h">${inline(m[1])}</p>`);
    } else {
      flushList();
      flushQuote();
      para.push(line);
    }
  }
  flush();
  return out.join('').replace(SLOT, (_, i) => slots[Number(i)]);
}

export function renderComment(el, text) {
  el.innerHTML = commentHTML(text);
}
