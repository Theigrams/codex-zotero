// Zotero annotations on the reader's pages. Drawn on each page's overlay (by percentage, like selections),
// hit-tested here, and changed through the server's write queue: every change shows at once and is
// written to Zotero in the background. Failed writes only show in the annotation drawer.
import { QA_TAG } from '../shared/annotations.mjs';

const POLL_MS = 3000;
const HIT_PT = 1.5;

const area = ([, , w, h]) => w * h;
const inside = ([x, y, w, h], [px, py], pad = HIT_PT) => px >= x - pad && px <= x + w + pad && py >= y - pad && py <= y + h + pad;

export class AnnotationLayer {
  constructor({ reader, call, onChange }) {
    Object.assign(this, { reader, call, onChange });
    this.doc = null;
    this.items = [];
    this.writes = [];
    this.active = null;
    this.seq = 0;
    this.timer = 0;
  }

  load(doc) {
    clearTimeout(this.timer);
    Object.assign(this, { doc, items: [], writes: [], rev: '', error: '', pending: 0, available: !!doc.attachmentKey, active: null });
    this.redraw();
    if (this.available) this.poll();
  }

  stop() {
    clearTimeout(this.timer);
    this.doc = null;
  }

  async poll() {
    const doc = this.doc;
    if (!doc) return;
    if (document.visibilityState === 'visible') await this.refresh().catch(() => {});
    if (this.doc === doc) this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  async refresh() {
    const seq = this.seq;
    const r = await this.call('annotations_list', { docId: this.doc.id, since: this.rev });
    if (seq === this.seq && !r.unchanged) this.apply(r); // a write started meanwhile: its own reply is newer
  }

  apply(r) {
    this.rev = r.rev;
    this.items = r.items || [];
    this.writes = r.writes || [];
    this.error = r.error || '';
    this.pending = r.pending || 0;
    this.redraw();
    this.onChange?.();
  }

  find(key) {
    return this.items.find(a => a.key === key) || null;
  }

  // ---------- writes ----------

  async write(name, args, optimistic) {
    const seq = ++this.seq;
    optimistic?.();
    this.redraw();
    this.onChange?.();
    try {
      const r = await this.call(name, { docId: this.doc.id, ...args });
      if (seq === this.seq) this.apply(r);
      return r;
    } catch (e) {
      if (seq === this.seq) await this.refresh().catch(() => {});
      throw e;
    }
  }

  // sel: the reader selection ({ kind, page, rects | rect, text, a }).
  async create(sel, { color, type = 'highlight' }) {
    if (!this.available) throw new Error('这篇 PDF 不是从 Zotero 打开的，批注无处保存。');
    const region = sel.kind === 'region';
    const rects = region ? [sel.rect] : sel.rects;
    const temp = { key: `tmp-${this.seq + 1}`, type: region ? 'image' : type, color, page: sel.page, rects, text: region ? '' : sel.text, comment: '', tags: [], sortIndex: '' };
    const r = await this.write('annotation_create', {
      kind: sel.kind, page: sel.page, rects, ...(region ? {} : { text: sel.text, offset: sel.a }), color, ...(region ? {} : { type }),
    }, () => this.items.push(temp));
    return r.key;
  }

  update(key, patch) {
    return this.write('annotation_update', { key, ...patch }, () => {
      const a = this.find(key);
      if (a) Object.assign(a, patch);
    });
  }

  remove(key) {
    if (this.active === key) this.active = null;
    return this.write('annotation_delete', { key }, () => { this.items = this.items.filter(a => a.key !== key); });
  }

  // ⌘Z: brings back the annotation deleted last (the server remembers it); resolves to its new key or null.
  async undo() {
    if (!this.available) return null;
    const r = await this.write('annotation_undo', {});
    return r.key;
  }

  retry(id, discard = false) {
    return this.write('annotation_retry', { id, discard });
  }

  // ---------- drawing ----------

  redraw() {
    for (const k of this.reader.pages.keys()) this.draw(k);
  }

  // Annotations sit under the selection highlight, in their own container on the page overlay.
  draw(k) {
    const pg = this.reader.pages.get(k);
    if (!pg) return;
    let box = pg.overlay.querySelector('.anns');
    if (!box) {
      box = document.createElement('div');
      box.className = 'anns';
      pg.overlay.prepend(box);
    }
    box.textContent = '';
    if (!this.doc) return;
    const [rx, ry, rw, rh] = this.reader.region(k - 1);
    const place = (cls, [x, y, w, h], color) => {
      const n = document.createElement('div');
      n.className = cls;
      Object.assign(n.style, { left: `${((x - rx) / rw) * 100}%`, top: `${((y - ry) / rh) * 100}%`, width: `${(w / rw) * 100}%`, height: `${(h / rh) * 100}%` });
      n.style.setProperty('--c', color);
      box.appendChild(n);
      return n;
    };
    for (const a of this.items) {
      const rects = a.page === k ? a.rects : a.page === k - 1 && a.nextRects ? a.nextRects : null;
      if (!rects) continue;
      const active = a.key === this.active ? ' active' : '';
      if (a.type === 'ink' && a.page === k) {
        box.appendChild(this.ink(a, [rx, ry, rw, rh]));
        continue;
      }
      const cls = { highlight: 'ann hl', underline: 'ann ul', image: 'ann img', note: 'ann note', text: 'ann txt' }[a.type] || 'ann img';
      for (const r of rects) place(cls + active, r, a.color);
      if (a.page === k && a.tags.includes(QA_TAG)) place(`ann mark${active}`, this.markRect(a, k), a.color);
    }
  }

  ink(a, [rx, ry, rw, rh]) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ann ink');
    svg.setAttribute('viewBox', `${rx} ${ry} ${rw} ${rh}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const p of a.paths) {
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', p.join(' '));
      Object.assign(line.style, { fill: 'none', stroke: a.color, strokeWidth: a.width, strokeLinecap: 'round', strokeLinejoin: 'round' });
      svg.appendChild(line);
    }
    return svg;
  }

  // AI answers get a small mark like a footnote sign, just after the end of the highlight.
  // Cropped pages have no margin to put it in, so it sits at the top right of the last line.
  markRect(a, k) {
    const [rx, , rw] = this.reader.region(k - 1);
    const last = a.rects.reduce((p, r) => (r[1] > p[1] + 1 || (Math.abs(r[1] - p[1]) <= 1 && r[0] > p[0]) ? r : p));
    return [Math.min(last[0] + last[2] + 0.5, rx + rw - 5), last[1] - 2.5, 4.5, 4.5];
  }

  // The annotation under a page point; the smallest one wins when they overlap.
  hit(k, pt) {
    let best = null;
    let bestArea = Infinity;
    for (const a of this.items) {
      const boxes = a.page === k ? [...a.rects] : a.page === k - 1 && a.nextRects ? [...a.nextRects] : [];
      if (a.page === k && a.paths) {
        const xs = a.paths.flatMap(p => p.filter((_, i) => i % 2 === 0)), ys = a.paths.flatMap(p => p.filter((_, i) => i % 2 === 1));
        boxes.push([Math.min(...xs) - a.width, Math.min(...ys) - a.width, Math.max(...xs) - Math.min(...xs) + 2 * a.width, Math.max(...ys) - Math.min(...ys) + 2 * a.width]);
      }
      if (a.page === k && a.tags.includes(QA_TAG)) boxes.push(this.markRect(a, k).map((v, i) => (i < 2 ? v - 3 : v + 6)));
      for (const b of boxes) {
        if (inside(b, pt) && area(b) < bestArea) {
          best = a;
          bestArea = area(b);
        }
      }
    }
    return best;
  }

  setActive(key) {
    if (this.active === key) return;
    this.active = key;
    this.redraw();
  }

  // Screen box of an annotation's drawn parts, for placing its popup.
  clientRect(key) {
    const nodes = [];
    for (const pg of this.reader.pages.values()) {
      pg.overlay.querySelectorAll('.anns .active').forEach(n => nodes.push(n));
    }
    if (!nodes.length || this.active !== key) return null;
    const rs = nodes.map(n => n.getBoundingClientRect());
    return { left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)), right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) };
  }

  // Briefly outlines an annotation after jumping to it from the drawer.
  flash(key) {
    this.setActive(key);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { if (this.active === key && !this.keepActive) this.setActive(null); }, 1200);
  }
}
