// What the model reads from a paper: repaired page text, in-paper search, and finding the place a
// quote comes from (to annotate or show it). Built on the same glyph data the panel selects with.
import { findAll, rectsOf, searchable, searchKey, textOf } from '../shared/text.mjs';

const MAX_READ_CHARS = 40000;

// Line structure kept (one line per line), hyphenated line ends joined.
export const plainText = page => (page.fullText ?? page.t.join('')).replace(/-\n/g, '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

export class Paper {
  constructor(text) {
    this.text = text;
  }

  page(doc, k) {
    if (!Number.isInteger(k) || k < 1 || k > doc.pageCount) throw new Error(`页码超出范围（1–${doc.pageCount}）。`);
    return this.text.page(doc, k);
  }

  async read(doc, from, to = from) {
    const a = Math.max(1, Math.min(from, to)), z = Math.min(doc.pageCount, Math.max(from, to));
    const pages = [];
    let used = 0;
    for (let k = a; k <= z; k++) {
      const text = plainText(await this.page(doc, k));
      if (used && used + text.length > MAX_READ_CHARS) {
        pages.push({ page: k, label: doc.pages[k - 1].label, truncated: true, text: '' });
        break;
      }
      used += text.length;
      pages.push({ page: k, label: doc.pages[k - 1].label, text });
    }
    return pages;
  }

  async find(doc, query, limit = 30) {
    const hits = [];
    for (let k = 1; k <= doc.pageCount && hits.length < limit; k++) {
      const page = await this.page(doc, k);
      if (page.fullText !== undefined) {
        const text = page.fullText.toLowerCase(), needle = query.toLowerCase();
        for (let at = text.indexOf(needle); needle && at >= 0 && hits.length < limit; at = text.indexOf(needle, at + needle.length)) {
          hits.push({ page: k, label: doc.pages[k - 1].label, snippet: page.fullText.slice(Math.max(0, at-70), at+needle.length+70), source: 'ocr' });
        }
        continue;
      }
      const index = searchable(page);
      const q = searchKey(query);
      for (let at = index.s.indexOf(q); q && at >= 0 && hits.length < limit; at = index.s.indexOf(q, at + q.length)) {
        const s = Math.max(0, at - 70), e = Math.min(index.s.length, at + q.length + 70);
        hits.push({ page: k, label: doc.pages[k - 1].label, snippet: `${s ? '…' : ''}${index.s.slice(s, e)}${e < index.s.length ? '…' : ''}` });
      }
    }
    return hits;
  }

  // The glyph range a quote comes from: tries the given page first, then its neighbors, then the rest.
  // Long quotes that don't match exactly (a word changed, a formula garbled) are found by their two ends.
  async locate(doc, quote, near) {
    const order = [];
    if (near) order.push(near, near - 1, near + 1);
    for (let k = 1; k <= doc.pageCount; k++) order.push(k);
    const seen = new Set();
    const q = searchKey(quote, { loose: true });
    if (q.length < 4) throw new Error('引文太短，无法在原文中定位；请给出至少一个完整短语。');
    for (const k of order) {
      if (k < 1 || k > doc.pageCount || seen.has(k)) continue;
      seen.add(k);
      const page = await this.page(doc, k);
      const index = searchable(page, { loose: true });
      let range = findAll(page, quote, { loose: true, index })[0];
      if (!range && q.length > 60) {
        const head = index.s.indexOf(q.slice(0, 30));
        const tail = head >= 0 ? index.s.indexOf(q.slice(-30), head) : -1;
        if (head >= 0 && tail >= 0 && tail + 30 - head < q.length * 1.5) range = [index.map[head], index.map[tail + 29]];
      }
      if (range) {
        const [a, z] = range;
        return { page: k, a, z, rects: rectsOf(page, a, z), text: textOf(page, a, z) };
      }
    }
    throw new Error('在论文中找不到这段引文；请从原文逐字摘取一个短句（可先用 find_in_paper 确认）。');
  }
}
