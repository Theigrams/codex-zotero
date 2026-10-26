// Enhanced recognition on the reader's pages. Jumps outline what MinerU found there (an equation's box, a figure
// with its sub-figures and caption, a table) instead of guessing it from the text layer; and the debug view (⇧M)
// draws every block MinerU found, numbered in its reading order, so a wrong split or order shows at a glance.
// In the debug view a click on a block copies what MinerU read there: text, LaTeX, the table as Markdown, or the
// picture of a figure.
import { pickUnit, unitsOf } from '../shared/blocks.mjs';

const NAMES = {
  text: '正文', title: '标题', equation: '公式', image: '图', chart: '图表', table: '表', code: '代码', algorithm: '算法', list: '列表',
  ref_text: '参考文献', header: '页眉', footer: '页脚', page_number: '页码', page_footnote: '脚注', aside_text: '旁注',
};
const nameOf = b => (b.type === 'text' && b.level ? '标题' : NAMES[b.type] || b.type);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// What a click copies: [kind of content, text] (text '' for a picture).
function contentOf(b, part) {
  if (part === 'caption') return ['图注', b.caption || ''];
  if (b.type === 'equation') return ['公式 LaTeX', b.latex || ''];
  if (b.type === 'table') return ['表格（Markdown）', b.table || b.text || ''];
  if (b.type === 'image' || b.type === 'chart') return ['图片', ''];
  return ['文字', String(b.text || '').replace(/^#+ /, '')];
}

export class BlockLayer {
  // copyText(text), copyImage(base64 PNG): to the clipboard; toast(text, ok); exitKey(): the key that toggles the view.
  constructor({ reader, call, copyText, copyImage, toast, exitKey }) {
    Object.assign(this, { reader, call, copyText, copyImage, toast, exitKey });
    this.pages = new Map(); // `${doc.id}:${k}` → Promise<blocks | null>
    this.on = false;
  }

  reset() {
    this.pages.clear();
    this.redraw();
  }

  blocksFor(k) {
    const doc = this.reader.doc;
    const key = `${doc.id}:${k}`;
    if (!this.pages.has(key)) {
      this.pages.set(key, this.call('recognition_page', { docId: doc.id, page: k })
        .then(r => r.blocks)
        .catch(e => { this.pages.delete(key); throw e; }));
    }
    return this.pages.get(key);
  }

  // The box of what a jump points at ({ x?, y, kind? }), when the paper is recognized and a block fits; else null.
  async target(k, at) {
    const blocks = await this.blocksFor(k);
    return (blocks && pickUnit(unitsOf(blocks), at)?.rect) || null;
  }

  // ---------- debug view ----------

  async toggle(page) {
    if (!this.on) {
      const blocks = await this.blocksFor(page).catch(() => null);
      if (!blocks) return this.toast('这篇还没有增强识别结果：先点 ✦ 识别。', false);
    }
    this.on = !this.on;
    document.body.classList.toggle('blocksOn', this.on);
    this.redraw();
    this.toast(this.on ? `调试模式：显示识别分块，点击一块复制它的内容；${this.exitKey()} 退出。` : '已退出调试模式。');
  }

  redraw() {
    for (const k of this.reader.pages.keys()) this.draw(k);
  }

  draw(k) {
    const pg = this.reader.pages.get(k);
    if (!pg) return;
    let box = pg.overlay.querySelector('.blocks');
    if (!this.on || !this.reader.doc) return box?.remove();
    if (!box) {
      box = document.createElement('div');
      box.className = 'blocks';
      box.addEventListener('mousedown', e => this.clicked(e, k));
      pg.overlay.appendChild(box);
    }
    const doc = this.reader.doc;
    this.blocksFor(k).then(blocks => {
      if (!this.on || this.reader.doc !== doc) return;
      box.textContent = '';
      box.blocks = blocks || [];
      const [rx, ry, rw, rh] = this.reader.region(k - 1);
      const place = (cls, [x, y, w, h]) => {
        const n = document.createElement('div');
        n.className = cls;
        Object.assign(n.style, { left: `${((x - rx) / rw) * 100}%`, top: `${((y - ry) / rh) * 100}%`, width: `${(w / rw) * 100}%`, height: `${(h / rh) * 100}%` });
        box.appendChild(n);
        return n;
      };
      // A figure made of several blocks: the box a jump to it outlines.
      for (const u of unitsOf(box.blocks)) {
        if (u.blocks.length > 1) place('grp', u.rect).dataset.label = `${u.label ? `图 ${u.label}` : '图'}（${u.blocks.length} 块合并）`;
      }
      box.blocks.forEach((b, i) => {
        if (!b.rect) return;
        const [what, text] = contentOf(b);
        const label = b.labels?.length ? ` (${b.labels.join(', ')})` : '';
        const n = place(`blk t-${b.type}${b.level ? ' t-title' : ''}`, b.rect);
        Object.assign(n.dataset, { i, label: `${i + 1} ${nameOf(b)}${label}` });
        n.title = `${i + 1} · ${nameOf(b)}${label} · 点击复制${what}${text ? `\n${clip(text, 300)}` : ''}`;
        if (b.captionRect) {
          const c = place('blk cap', b.captionRect);
          Object.assign(c.dataset, { i, part: 'caption', label: `${i + 1} 图注` });
          c.title = `${i + 1} · 图注 · 点击复制\n${clip(b.caption || '', 300)}`;
        }
      });
    }).catch(() => {});
  }

  // A click on a block copies it; it never starts a selection.
  async clicked(e, k) {
    const n = e.target.closest('.blk');
    if (!n || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const b = n.parentElement.blocks?.[Number(n.dataset.i)];
    if (!b) return;
    const [what, text] = contentOf(b, n.dataset.part);
    try {
      if (what === '图片') {
        const img = await this.call('selection_image', { docId: this.reader.doc.id, page: k, rect: b.rect, scale: 3 });
        await this.copyImage(img.data);
      } else {
        if (!text.trim()) return this.toast('这一块没有识别出内容。', false);
        await this.copyText(text);
      }
      this.toast(`已复制第 ${Number(n.dataset.i) + 1} 块的${what}。`);
    } catch (err) {
      this.toast(`没能复制：${err.message}`, false);
    }
  }
}
