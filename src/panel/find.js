// Find in the paper (⌘F). Searches the same repaired page text the selection uses, page by page from
// the current one, so the first matches show while later pages are still being read.
import { findAll, rectsOf } from '../shared/text.mjs';

const $ = id => document.getElementById(id);
const PARALLEL = 4;

export class Find {
  constructor({ reader, selection }) {
    Object.assign(this, { reader, selection });
    this.hits = [];
    this.cur = -1;
    this.token = 0;
    this.timer = 0;
    $('findInput').addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.search($('findInput').value), 200);
    });
    $('findInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    $('findPrev').addEventListener('click', () => this.step(-1));
    $('findNext').addEventListener('click', () => this.step(1));
    $('findClose').addEventListener('click', () => this.close());
  }

  get isOpen() {
    return !$('findBar').hidden;
  }

  open() {
    const sel = this.selection.current;
    if (sel?.kind === 'text' && sel.text.length < 80) $('findInput').value = sel.text;
    $('findBar').hidden = false;
    $('findInput').focus();
    $('findInput').select();
    if ($('findInput').value) this.search($('findInput').value);
  }

  close() {
    this.token++;
    $('findBar').hidden = true;
    this.hits = [];
    this.cur = -1;
    this.curHit = null;
    this.redraw();
    this.reader.scroller.focus({ preventScroll: true });
  }

  reset() {
    if (this.isOpen) this.close();
  }

  async search(query) {
    const token = ++this.token;
    this.hits = [];
    this.cur = -1;
    this.curHit = null;
    this.redraw();
    if (!query.trim() || !this.reader.doc) return this.count('');
    const n = this.reader.doc.pageCount;
    const start = this.reader.currentPage();
    const order = Array.from({ length: n }, (_, i) => ((start - 1 + i) % n) + 1);
    let done = 0;
    this.count(`0 / 第 ${done}/${n} 页`);
    const run = async () => {
      while (order.length) {
        const k = order.shift();
        let text;
        try {
          text = await this.selection.textFor(k);
        } catch {
          continue;
        }
        if (token !== this.token) return;
        for (const [a, z] of findAll(text, query)) this.hits.push({ page: k, a, rects: rectsOf(text, a, z) });
        done++;
        this.hits.sort((x, y) => x.page - y.page || x.a - y.a);
        if (this.cur < 0) {
          const first = this.hits.findIndex(h => h.page >= start);
          if (first >= 0) this.go(first);
        } else {
          this.redraw(); // keeps cur pointing at the same hit after the sort
        }
        this.count(done < n ? `${this.hits.length} · 第 ${done}/${n} 页` : null);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, run));
    if (token !== this.token) return;
    if (this.cur < 0 && this.hits.length) this.go(0);
    this.count(null);
  }

  count(text) {
    $('findCount').textContent = text ?? (this.hits.length ? `${this.cur + 1} / ${this.hits.length}` : '没有结果');
  }

  go(i) {
    const h = this.hits[i];
    if (!h) return;
    this.curHit = h;
    this.cur = i;
    this.reader.scrollToPoint(h.page, Math.min(...h.rects.map(r => r[1])));
    this.redraw();
    this.count(null);
  }

  step(d) {
    if (!this.hits.length) return;
    const i = this.hits.indexOf(this.curHit);
    this.go((((i < 0 ? 0 : i + d) % this.hits.length) + this.hits.length) % this.hits.length);
  }

  redraw() {
    if (this.curHit) this.cur = this.hits.indexOf(this.curHit);
    for (const k of this.reader.pages.keys()) this.draw(k);
  }

  draw(k) {
    const pg = this.reader.pages.get(k);
    if (!pg) return;
    pg.overlay.querySelector('.finds')?.remove();
    const mine = this.hits.filter(h => h.page === k);
    if (!mine.length) return;
    const box = document.createElement('div');
    box.className = 'finds';
    const [rx, ry, rw, rh] = this.reader.region(k - 1);
    for (const h of mine) {
      for (const [x, y, w, hh] of h.rects) {
        const n = document.createElement('div');
        n.className = h === this.curHit ? 'hit cur' : 'hit';
        Object.assign(n.style, { left: `${((x - rx) / rw) * 100}%`, top: `${((y - ry) / rh) * 100}%`, width: `${(w / rw) * 100}%`, height: `${(hh / rh) * 100}%` });
        box.appendChild(n);
      }
    }
    pg.overlay.querySelector('.anns')?.after(box) ?? pg.overlay.prepend(box);
  }
}
