// Text and region selection on the reader's pages. Selections live in page points (crop-box space,
// top-left origin) and are drawn on each page's overlay by percentage, so zoom and crop never move them.
import { hitGlyph, linesOf, rangesOf, rectsOf, sentenceAt, textOf, wordAt } from '../shared/text.mjs';

const DRAG_PX = 3;       // pointer travel that turns a click into a drag
const MIN_REGION_PT = 4; // smaller ⌥-drags are treated as clicks

export class Selection {
  // onClick(page, point): a plain click on a page (after clearing the selection), e.g. to open an annotation.
  constructor({ reader, call, onChange, onClick }) {
    Object.assign(this, { reader, call, onChange, onClick });
    this.texts = new Map();
    this.current = null;
    this.drag = null;
    reader.content.addEventListener('mousedown', e => this.down(e));
    window.addEventListener('mousemove', e => this.move(e));
    window.addEventListener('mouseup', () => this.up());
  }

  // ---------- page text ----------

  textFor(page) {
    const key = `${this.reader.doc.id}:${page}`;
    if (!this.texts.has(key)) {
      this.texts.set(key, this.call('page_text', { docId: this.reader.doc.id, page })
        .then(t => ({ ...t, lines: linesOf(t) }))
        .catch(e => { this.texts.delete(key); throw e; }));
    }
    return this.texts.get(key);
  }

  prefetch(pages) {
    for (const p of pages) this.textFor(p).catch(() => {});
  }

  // ---------- pointer ----------

  pointAt(e, el, k) {
    const r = el.getBoundingClientRect();
    const [rx, ry, rw, rh] = this.reader.region(k - 1);
    return [rx + ((e.clientX - r.left) / r.width) * rw, ry + ((e.clientY - r.top) / r.height) * rh];
  }

  down(e) {
    const el = e.target.closest?.('.page');
    if (e.button !== 0 || !el || !this.reader.doc) return;
    e.preventDefault(); // no native image drag or text selection
    const k = Number(el.dataset.page);
    const pt = this.pointAt(e, el, k);
    this.drag = { kind: e.altKey ? 'region' : 'text', k, el, start: pt, last: pt, x: e.clientX, y: e.clientY, clicks: e.detail, event: { shiftKey: e.shiftKey }, moved: false, text: null };
    if (this.drag.kind === 'text') {
      const drag = this.drag;
      this.textFor(k).then(text => {
        drag.text = text;
        if (this.drag !== drag && drag.clicks < 2) return;
        if (drag.clicks >= 2) {
          const i = hitGlyph(text, text.lines, ...drag.start);
          if (i < 0) return;
          if (drag.clicks === 2) return this.selectRange(k, text, ...wordAt(text, i));
          const s = sentenceAt(text, text.lines, i, { height: this.reader.doc.pages[k - 1].height });
          this.selectRange(k, text, s.a, s.z, true, s.skip);
        } else if (drag.moved) {
          this.extend(drag);
        }
      }).catch(() => {});
    }
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    d.last = this.pointAt(e, d.el, d.k);
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    d.moved = true;
    if (d.kind === 'region') {
      const [x0, y0] = d.start, [x1, y1] = d.last;
      this.set({ kind: 'region', page: d.k, rect: [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)] }, false);
    } else if (d.text && d.clicks < 2) {
      this.extend(d);
    }
  }

  extend(d) {
    const a = hitGlyph(d.text, d.text.lines, ...d.start);
    const z = hitGlyph(d.text, d.text.lines, ...d.last);
    if (a >= 0 && z >= 0) this.selectRange(d.k, d.text, Math.min(a, z), Math.max(a, z), false);
  }

  up() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'region') {
      const r = this.current?.kind === 'region' ? this.current.rect : null;
      if (!d.moved || !r || r[2] < MIN_REGION_PT || r[3] < MIN_REGION_PT) {
        this.set(null);
        if (!d.moved) this.onClick?.(d.k, d.start, d.event);
      }
      else this.set(this.current);
    } else if (!d.moved && d.clicks < 2) {
      this.set(null); // a plain click clears
      this.onClick?.(d.k, d.start, d.event);
    } else if (this.current) {
      this.set(this.current);
    }
  }

  // ---------- state and drawing ----------

  // skip: glyph ranges inside a..z left out (a running header or caption between two columns of one sentence).
  selectRange(k, text, a, z, final = true, skip = []) {
    const ranges = rangesOf(a, z, skip);
    const rects = ranges.flatMap(([s, e]) => rectsOf(text, s, e));
    if (!rects.length) return;
    this.set({ kind: 'text', page: k, a, z, text: ranges.map(([s, e]) => textOf(text, s, e)).join(' '), rects }, final);
  }

  // final=false while dragging: draw, but let listeners skip expensive work.
  set(sel, final = true) {
    const before = this.current?.page;
    this.current = sel;
    if (before && before !== sel?.page) this.draw(before);
    if (sel) this.draw(sel.page);
    this.onChange?.(sel, final);
  }

  clear() {
    if (this.current) this.set(null);
  }

  // Called by the reader whenever a page element is (re)created.
  draw(k) {
    const pg = this.reader.pages.get(k);
    if (!pg) return;
    pg.overlay.querySelectorAll(':scope > .sel, :scope > .region').forEach(n => n.remove());
    const s = this.current;
    if (!s || s.page !== k) return;
    const [rx, ry, rw, rh] = this.reader.region(k - 1);
    const place = (cls, [x, y, w, h]) => {
      const n = document.createElement('div');
      n.className = cls;
      Object.assign(n.style, { left: `${((x - rx) / rw) * 100}%`, top: `${((y - ry) / rh) * 100}%`, width: `${(w / rw) * 100}%`, height: `${(h / rh) * 100}%` });
      pg.overlay.appendChild(n);
    };
    if (s.kind === 'text') s.rects.forEach(r => place('sel', r));
    else place('region', s.rect);
  }

  // Page-point bounding box of the current selection (for the crop sent with a question).
  bounds() {
    const s = this.current;
    if (!s) return null;
    if (s.kind === 'region') return s.rect;
    const x0 = Math.min(...s.rects.map(r => r[0])), y0 = Math.min(...s.rects.map(r => r[1]));
    const x1 = Math.max(...s.rects.map(r => r[0] + r[2])), y1 = Math.max(...s.rects.map(r => r[1] + r[3]));
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // Screen box of the drawn selection, for placing the toolbar; null when it is off screen.
  clientRect() {
    const pg = this.current && this.reader.pages.get(this.current.page);
    const nodes = pg ? [...pg.overlay.querySelectorAll(':scope > .sel, :scope > .region')] : [];
    if (!nodes.length) return null;
    const rs = nodes.map(n => n.getBoundingClientRect());
    return { left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)), right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) };
  }
}
