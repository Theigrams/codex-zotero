// Links inside the paper ("式 (19)", "Fig. 9", "[12]"): click to jump, ⌥← (or the ↩ in the bar) to go back, ⌥→ forward again (both rebindable).
// Resting the pointer on a link shows a small picture of where it leads, rendered from the original,
// so a reference or equation can be read without leaving the page. Nothing appears unless pointed at.

const $ = id => document.getElementById(id);
const PREVIEW_DELAY_MS = 350;
const PREVIEW_HEIGHT_PT = 140;
const MAX_BACK = 50;

const inside = ([x, y, w, h], [px, py]) => px >= x && px <= x + w && py >= y && py <= y + h;

export class Links {
  // pointAt(e, el, k) → page point; textFor(k) → page text with lines; onMove(): after a jump; openUrl(url).
  // flash(page, { x, y }, fallbackRect): outline what the link leads to.
  constructor({ reader, call, pointAt, textFor, onMove, openUrl, flash }) {
    Object.assign(this, { reader, call, pointAt, textFor, onMove, openUrl, flashAt: flash });
    this.loading = new Map();
    this.ready = new Map();
    this.back = [];
    this.forward = [];
    this.previews = new Map();
    this.hover = null;
    this.timer = 0;
    this.el = $('linkPreview');
    reader.content.addEventListener('mousemove', e => this.moved(e));
    reader.content.addEventListener('mouseleave', () => this.unhover());
    reader.scroller.addEventListener('scroll', () => this.unhover(), { passive: true });
  }

  reset() {
    this.loading.clear();
    this.ready.clear();
    this.previews.clear();
    this.back = [];
    this.forward = [];
    this.unhover();
    this.onMove?.();
  }

  prefetch(pages) {
    const doc = this.reader.doc;
    for (const k of pages) {
      const key = `${doc.id}:${k}`;
      if (this.loading.has(key)) continue;
      this.loading.set(key, this.call('page_links', { docId: doc.id, page: k })
        .then(r => this.ready.set(key, r.links))
        .catch(() => this.loading.delete(key)));
    }
  }

  hit(k, pt) {
    const list = this.reader.doc && this.ready.get(`${this.reader.doc.id}:${k}`);
    return list?.find(l => inside(l.rect, pt) && (l.page || l.url)) || null;
  }

  // ---------- jumping ----------

  follow(link) {
    this.unhover();
    if (link.url) return this.openUrl?.(link.url);
    this.push(this.back);
    this.forward = [];
    const [rx, ry, rw] = this.reader.region(link.page - 1);
    const y = link.point?.[1] ?? ry;
    this.reader.scrollToPoint(link.page, y, 0.12);
    if (this.flashAt) this.flashAt(link.page, { x: link.point?.[0] ?? null, y }, [rx, y - 2, rw, 14]);
    else this.flash(link.page, [rx, y - 2, rw, 14]);
    this.onMove?.();
  }

  push(stack) {
    stack.push(this.reader.position());
    if (stack.length > MAX_BACK) stack.shift();
  }

  // Back and forward walk the positions links were followed from; each step keeps where it left.
  step(from, to) {
    const pos = from.pop();
    if (!pos) return false;
    this.push(to);
    this.reader.scrollToPage(pos.page, pos.offset);
    this.onMove?.();
    return true;
  }

  goBack() {
    return this.step(this.back, this.forward);
  }

  goForward() {
    return this.step(this.forward, this.back);
  }

  get backPage() {
    return this.back.at(-1)?.page ?? null;
  }

  flash(k, [x, y, w, h]) {
    requestAnimationFrame(() => {
      const pg = this.reader.pages.get(k);
      if (!pg) return;
      const [rx, ry, rw, rh] = this.reader.region(k - 1);
      const n = document.createElement('div');
      n.className = 'flash';
      Object.assign(n.style, { left: `${((x - rx) / rw) * 100}%`, top: `${((y - ry) / rh) * 100}%`, width: `${(w / rw) * 100}%`, height: `${(h / rh) * 100}%` });
      pg.overlay.appendChild(n);
      setTimeout(() => n.remove(), 1200);
    });
  }

  // ---------- pointer ----------

  moved(e) {
    if (e.buttons) return;
    const el = e.target.closest?.('.page');
    if (!el || !this.reader.doc) return this.unhover();
    const k = Number(el.dataset.page);
    const link = this.hit(k, this.pointAt(e, el, k));
    el.style.cursor = link ? 'pointer' : '';
    if (link === this.hover?.link) {
      if (link) this.place(e);
      return;
    }
    this.unhover();
    if (!link) return;
    this.hover = { link, x: e.clientX, y: e.clientY };
    if (link.page) this.timer = setTimeout(() => this.preview(link), PREVIEW_DELAY_MS);
  }

  unhover() {
    clearTimeout(this.timer);
    this.hover = null;
    this.el.hidden = true;
  }

  async preview(link) {
    const doc = this.reader.doc;
    const key = `${doc.id}:${link.page}:${link.point?.[1] ?? 'top'}`;
    if (!this.previews.has(key)) {
      this.previews.set(key, this.targetRect(link)
        .then(rect => this.call('selection_image', { docId: doc.id, page: link.page, rect, scale: 2.5 }))
        .catch(e => { this.previews.delete(key); throw e; }));
    }
    let img;
    try {
      img = await this.previews.get(key);
    } catch {
      return;
    }
    if (this.hover?.link !== link) return;
    const pic = this.el.querySelector('img');
    pic.src = `data:image/png;base64,${img.data}`;
    pic.style.aspectRatio = `${img.width} / ${img.height}`;
    $('linkPreviewLabel').textContent = `第 ${link.page} 页 · 点击跳转`;
    this.el.hidden = false;
    this.place();
  }

  // The part of the target page to show: from just above the target, and only its column when the text
  // there is set in columns (judged from the lines below the target point), so the preview stays legible.
  async targetRect(link) {
    const [rx, ry, rw, rh] = this.reader.doc.crops[link.page - 1];
    const y = link.point?.[1] ?? ry;
    const top = Math.max(ry, Math.min(ry + rh - PREVIEW_HEIGHT_PT, y - 10));
    const full = [rx, top, rw, Math.min(PREVIEW_HEIGHT_PT, rh)];
    const px = link.point?.[0];
    if (px == null) return full;
    let text;
    try {
      text = await this.textFor(link.page);
    } catch {
      return full;
    }
    const mid = rx + rw / 2;
    const near = text.lines.filter(L => L.y0 >= top && L.y0 <= top + PREVIEW_HEIGHT_PT);
    const xs = near.map(L => L.glyphs.map(i => [text.b[i * 4], text.b[i * 4] + text.b[i * 4 + 2]]).reduce((a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])]));
    if (!xs.length || xs.some(([x0, x1]) => x0 < mid - 20 && x1 > mid + 20)) return full; // a line crosses the middle: one column
    const left = px < mid;
    const pad = 6;
    return left ? [rx, top, rw / 2 + pad, full[3]] : [mid - pad, top, rw / 2 + pad, full[3]];
  }

  place(e) {
    if (e && this.hover) Object.assign(this.hover, { x: e.clientX, y: e.clientY });
    if (this.el.hidden || !this.hover) return;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const below = this.hover.y + 18;
    const top = below + h < window.innerHeight - 4 ? below : Math.max(4, this.hover.y - h - 12);
    this.el.style.top = `${top}px`;
    this.el.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, this.hover.x - w / 2))}px`;
  }
}
