// Continuous reader: virtualized pages, low-res previews, sharp strips, pinch zoom.
// Layout math comes from src/shared/layout.mjs so it matches what the server renders.
import { remotePagePlan } from '../shared/remote-page.mjs';
import { fullRegion, pagePlan, stripsFor } from '../shared/layout.mjs';

const SETTLE_MS = 60;          // scroll idle time before the sharp strips are requested
const ZOOM_END_MS = 150;       // pinch idle time before re-rendering at the new size
const PREFETCH_EVERY_MS = 150; // while scrolling, prefetch a screen ahead at most this often
const MAX_INFLIGHT = 4;        // strip requests outstanding at once; the rest wait and can be dropped
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

const dpr = () => window.devicePixelRatio || 1;

// data: URLs, not blob: — the Codex panel sandbox blocks blob: images (phase 1 acceptance) and
// 127.0.0.1 (spike S1); data: is what the S1 spike verified. Dropping the src frees the string.
const pngSrc = (base64,mimeType='image/png') => `data:${mimeType==='image/webp'?mimeType:'image/png'};base64,${base64}`;

function release(img) {
  img.remove();
  img.removeAttribute('src');
}

export class Reader {
  constructor({ scroller, content, call, topInset = 0, onPage, onIdle, onImageError, onPageCreated, remote=false }) {
    Object.assign(this, { scroller, content, call, topInset, onPage, onIdle, onImageError, onPageCreated, remote });
    this.imageStats = { loaded: 0, failed: 0 };
    this.doc = null;
    this.mode = 'aligned';
    this.crop = true;
    this.zoom = 1;
    this.layout = [];
    this.pages = new Map();     // page → { el, preview, strips: Map(key → strip record) }
    this.queue = new Map();     // strip key → pending request, re-prioritized on every refresh
    this.inflight = 0;
    this.gesture = null;
    this.lastPage = 0;
    this.metrics = { sharpAfterScroll: [], sharpAfterZoom: [], frames: [] };
    this.pendingSharp = null;
    this.bind();
  }

  // ---------- public ----------

  load(doc, { mode, position }) {
    this.clear();
    this.doc = doc;
    this.mode = mode;
    this.zoom = position?.zoom ?? 1;
    this.relayout();
    const page = Math.min(doc.pageCount, position?.page ?? 1);
    this.scrollToPage(page, position?.offset ?? 0);
    this.startSharp('open');
    this.syncPages();
    this.refresh();
  }

  setMode(mode) {
    if (mode === this.mode || !this.doc) return;
    this.mode = mode;
    this.relayoutKeepingAnchor(this.centerAnchor());
    this.startSharp('mode');
    this.refresh();
  }

  toggleCrop() {
    if (!this.doc) return;
    const anchor = this.centerAnchor();
    this.crop = !this.crop;
    for (const k of [...this.pages.keys()]) this.dropPage(k);
    this.queue.clear();
    this.relayoutKeepingAnchor(anchor);
    this.syncPages();
    this.refresh();
  }

  zoomBy(factor, point = this.centerPoint()) {
    if (!this.doc) return;
    const anchor = this.anchorAt(point.x + this.scroller.scrollLeft, point.y + this.scroller.scrollTop, point);
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    this.relayoutKeepingAnchor(anchor);
    this.startSharp('zoom');
    this.refresh();
  }

  fitWidth() {
    this.zoomBy(1 / this.zoom);
  }

  scrollToPage(page, offset = 0) {
    const L = this.layout[page - 1];
    if (!L) return;
    this.programmaticUntil = performance.now() + 80;
    this.scroller.scrollTop = Math.max(0, L.top + offset * L.h - this.topInset);
  }

  // Brings a page point (page points, top-left origin) to a fraction of the way down the view (a third by default).
  scrollToPoint(page, y, at = 1 / 3) {
    const L = this.layout[page - 1];
    if (!L) return;
    const [, ry, , rh] = this.region(page - 1);
    this.programmaticUntil = performance.now() + 80;
    this.scroller.scrollTop = Math.max(0, L.top + ((y - ry) / rh) * L.h - Math.max(this.topInset + 8, this.scroller.clientHeight * at));
  }

  position() {
    const page = this.pageAt(this.scroller.scrollTop + this.topInset + 1);
    const L = this.layout[page - 1];
    const offset = Math.min(1, Math.max(0, (this.scroller.scrollTop + this.topInset - L.top) / L.h));
    return { page, offset, zoom: this.zoom };
  }

  currentPage() {
    return this.pageAt(this.scroller.scrollTop + this.scroller.clientHeight / 2);
  }

  destroy() {
    this.clear();
    this.doc = null;
  }

  // ---------- layout ----------

  region(i) {
    return this.crop ? this.doc.crops[i] : fullRegion(this.doc.pages[i]);
  }

  relayout() {
    const vw = this.scroller.clientWidth;
    const d = dpr();
    const target = Math.max(200, Math.round(vw * this.zoom));
    let top = this.topInset;
    this.layout = this.doc.pages.map((_, i) => {
      const r = this.region(i);
      const plan = (this.remote ? remotePagePlan : (w,d,r)=>pagePlan(this.mode,w,d,r))(target, d, { w: r[2], h: r[3] });
      const L = { top, w: plan.cssW, h: plan.cssH, plan };
      top += plan.cssH + 1; // 1px hairline between pages
      return L;
    });
    const w = this.layout[0]?.w ?? vw;
    this.left = Math.max(0, Math.round(((vw - w) / 2) * d) / d);
    this.content.style.width = `${Math.max(vw, this.left * 2 + w)}px`;
    this.content.style.height = `${top}px`;
    for (const [k, pg] of this.pages) this.placePage(k, pg);
  }

  relayoutKeepingAnchor(anchor) {
    this.relayout();
    const L = this.layout[anchor.page - 1];
    this.programmaticUntil = performance.now() + 80;
    this.scroller.scrollLeft = this.left + anchor.fx * L.w - anchor.vx;
    this.scroller.scrollTop = L.top + anchor.fy * L.h - anchor.vy;
    this.syncPages();
  }

  anchorAt(x, y, viewport) {
    const page = this.pageAt(y);
    const L = this.layout[page - 1];
    return { page, fx: (x - this.left) / L.w, fy: (y - L.top) / L.h, vx: viewport.x, vy: viewport.y };
  }

  centerPoint() {
    return { x: this.scroller.clientWidth / 2, y: this.scroller.clientHeight / 2 };
  }

  centerAnchor() {
    const p = this.centerPoint();
    return this.anchorAt(p.x + this.scroller.scrollLeft, p.y + this.scroller.scrollTop, p);
  }

  pageAt(y) {
    const L = this.layout;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (L[mid].top <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  range(margin) {
    const top = this.scroller.scrollTop - margin;
    const bottom = this.scroller.scrollTop + this.scroller.clientHeight + margin;
    const first = this.pageAt(Math.max(0, top));
    let last = first;
    while (last < this.layout.length && this.layout[last].top <= bottom) last++;
    return [first, last];
  }

  // ---------- pages and images ----------

  placePage(k, pg) {
    const L = this.layout[k - 1];
    Object.assign(pg.el.style, { left: `${this.left}px`, top: `${L.top}px`, width: `${L.w}px`, height: `${L.h}px` });
    for (const s of pg.strips.values()) this.placeStrip(s, L.plan);
  }

  // Strips of the current plan in 'aligned' mode sit on exact device pixels; everything else is
  // positioned by fraction of the page, so it scales with the page until replaced.
  placeStrip(s, plan) {
    if (!this.remote && s.planKey === plan.key && plan.mode === 'aligned') {
      const d = dpr();
      s.img.style.top = `${s.y / d}px`;
      s.img.style.height = `${s.h / d}px`;
    } else {
      s.img.style.top = `${s.f0 * 100}%`;
      s.img.style.height = `${(s.f1 - s.f0) * 100}%`;
    }
  }

  ensurePage(k) {
    let pg = this.pages.get(k);
    if (pg) return pg;
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = k;
    const preview = new Image();
    preview.className = 'preview';
    preview.alt = '';
    const overlay = document.createElement('div'); // selections and, later, annotations
    overlay.className = 'overlay';
    el.append(preview, overlay);
    this.content.appendChild(el);
    pg = { el, preview, overlay, strips: new Map() };
    if(this.remote){
      pg.status=document.createElement('div');pg.status.className='page-status';
      pg.status.setAttribute('role','status');pg.status.textContent=`正在加载第 ${k} 页…`;el.append(pg.status);
    }
    this.pages.set(k, pg);
    this.placePage(k, pg);
    this.onPageCreated?.(k, pg);
    const docId = this.doc.id, crop = this.crop;
    if(!this.remote)this.call('render_preview', { docId, page: k, crop })
      .then(async r => {
        if (this.pages.get(k) !== pg) return;
        preview.src = pngSrc(r.data);
        await preview.decode();
        this.imageLoaded();
      })
      .catch(e => { if (this.pages.get(k) === pg) this.imageFailed(e); }); // a dropped page is not a failure
    return pg;
  }

  dropPage(k) {
    const pg = this.pages.get(k);
    if (!pg) return;
    for (const s of pg.strips.values()) release(s.img);
    release(pg.preview);
    pg.el.remove();
    this.pages.delete(k);
  }

  clear() {
    for (const k of [...this.pages.keys()]) this.dropPage(k);
    this.queue.clear();
    this.failures?.clear();
  }

  syncPages() {
    if (!this.doc) return;
    const [first, last] = this.range(this.scroller.clientHeight);
    for (let k = first; k <= last; k++) this.ensurePage(k);
    for (const k of [...this.pages.keys()]) if (k < first - (this.remote?1:6) || k > last + (this.remote?1:6)) this.dropPage(k);
  }

  // Works out which strips should exist now, queues the missing ones (visible first),
  // forgets queued ones that scrolled away and releases strips far from the view.
  refresh(ahead = 0) {
    if (!this.doc) return;
    const view = this.scroller.clientHeight;
    const top = this.scroller.scrollTop, bottom = top + view;
    const lo = this.remote ? top : top - view * 0.75 + Math.min(0, ahead) * view;
    const hi = this.remote ? bottom : bottom + view * 0.75 + Math.max(0, ahead) * view;
    const [first, last] = this.range(Math.max(top - lo, hi - bottom));
    const wanted = new Map();
    const visible = [];
    for (let k = first; k <= last; k++) {
      const L = this.layout[k - 1];
      const pg = this.ensurePage(k);
      for (const s of this.remote ? [{index:0,y:0,h:L.plan.bitmapH}] : stripsFor(L.plan)) {
        const y0 = L.top + (s.y / L.plan.bitmapH) * L.h;
        const y1 = L.top + ((s.y + s.h) / L.plan.bitmapH) * L.h;
        if (y1 < lo || y0 > hi) continue;
        const key = `${k}|${this.crop ? 'c' : 'f'}|${L.plan.key}|${s.index}`;
        const isVisible = y1 >= top && y0 <= bottom;
        if (isVisible) visible.push(key); // ready or not: the sharp measurement waits for all of them
        if (pg.strips.get(key)?.ready || (this.remote && (this.failures?.get(key)||0)>2)) continue;
        wanted.set(key, { k, s, plan: L.plan, priority: isVisible ? 0 : 1, distance: Math.abs((y0 + y1) / 2 - (top + bottom) / 2) });
      }
    }
    for (const key of [...this.queue.keys()]) if (!wanted.has(key)) this.queue.delete(key);
    for (const [key, job] of wanted) {
      const pg = this.pages.get(job.k);
      if (!pg.strips.has(key) && !this.queue.has(key)) this.queue.set(key, job);
      else if (this.queue.has(key)) Object.assign(this.queue.get(key), { priority: job.priority, distance: job.distance });
    }
    for (const [k, pg] of this.pages) {
      if (k >= first - 1 && k <= last + 1) continue;
      for (const s of pg.strips.values()) release(s.img);
      pg.strips.clear();
    }
    this.visibleKeys = visible;
    this.pump();
    this.checkSharp();
  }

  pump() {
    while (this.inflight < (this.remote ? 2 : MAX_INFLIGHT) && this.queue.size) {
      let bestKey = null, best = null;
      for (const [key, job] of this.queue) {
        if (!best || job.priority < best.priority || (job.priority === best.priority && job.distance < best.distance)) {
          bestKey = key;
          best = job;
        }
      }
      this.queue.delete(bestKey);
      this.fetchStrip(bestKey, best);
    }
  }

  fetchStrip(key, { k, s, plan, priority }) {
    const pg = this.pages.get(k);
    if (!pg) return;
    const img = new Image();
    img.alt = '';
    const rec = { img, planKey: plan.key, y: s.y, h: s.h, f0: s.y / plan.bitmapH, f1: (s.y + s.h) / plan.bitmapH, ready: false };
    pg.strips.set(key, rec);
    this.placeStrip(rec, plan);
    this.inflight++;
    const L = this.layout[k - 1];
    const args={docId:this.doc.id,page:k,cssWidth:L.w,dpr:dpr(),crop:this.crop,priority};
    this.call(this.remote ? 'render_page' : 'render_strip', this.remote ? args : {...args,mode:plan.mode,cssWidth:plan.mode==='aligned'?L.w:plan.cssW,index:s.index})
      .then(async r => {
        if (pg.strips.get(key) !== rec) return;
        img.src = pngSrc(r.data,r.mimeType);
        await img.decode();
        this.imageLoaded();
        if (pg.strips.get(key) !== rec || !this.pages.has(k)) return release(img);
        // Under the overlay: highlights multiply onto the page image, so text under them stays black.
        pg.el.insertBefore(img, pg.overlay);
        rec.ready = true;
        if(pg.status)pg.status.hidden=true;
        this.retireCovered(pg, rec);
      })
      .catch(e => {
        if (pg.strips.get(key) !== rec) return; // released while loading: not a failure
        pg.strips.delete(key);
        if(!this.remote)this.imageFailed(e);
        if(this.remote){
          this.imageStats.failed++;this.imageStats.lastError=String(e?.message||e);
          if(pg.status && ![...pg.strips.values()].some(s=>s.ready)){
            pg.status.hidden=false;pg.status.textContent=`第 ${k} 页未能加载 `;
            const retry=document.createElement('button');retry.textContent='重试';retry.title=String(e?.message||e);
            retry.onclick=()=>{this.failures?.delete(key);pg.status.textContent=`正在加载第 ${k} 页…`;this.refresh();};pg.status.append(retry);
          }
          const failures=(this.failures ||= new Map()),count=(failures.get(key)||0)+1;failures.set(key,count);
          if(count<=2)setTimeout(()=>{if(this.pages.get(k)===pg && this.doc)this.refresh();},count*1500);
        }
      })
      .finally(() => {
        this.inflight--;
        this.pump();
        this.checkSharp();
      });
  }

  // Once a strip of the current size is up, older-size strips under it are redundant.
  retireCovered(pg, rec) {
    for (const [key, o] of pg.strips) {
      if (o !== rec && o.planKey !== rec.planKey && o.f0 < rec.f1 && o.f1 > rec.f0) {
        release(o.img);
        pg.strips.delete(key);
      }
    }
  }

  // ---------- image health ----------

  imageLoaded() {
    this.imageStats.loaded++;
  }

  // A page image that never shows must not look like an empty page: once several fail and none has
  // loaded, tell the user why.
  imageFailed(error) {
    this.imageStats.failed++;
    this.imageStats.lastError = String(error?.message || error);
    if (this.imageStats.loaded === 0 && this.imageStats.failed === 3) this.onImageError?.(this.imageStats.lastError);
  }

  // ---------- measurements (shown by the ⇧D debug line) ----------

  startSharp(reason, since = performance.now()) {
    this.pendingSharp = { reason, since };
  }

  checkSharp() {
    if (!this.pendingSharp || !this.visibleKeys?.length) return;
    const ready = this.visibleKeys.every(key => this.pages.get(Number(key.split('|')[0]))?.strips.get(key)?.ready);
    if (!ready) return;
    const ms = Math.round(performance.now() - this.pendingSharp.since);
    const list = this.pendingSharp.reason === 'zoom' ? this.metrics.sharpAfterZoom : this.metrics.sharpAfterScroll;
    if (this.pendingSharp.reason === 'open') this.metrics.openSharpMs = ms;
    else list.push(ms);
    this.pendingSharp = null;
  }

  trackFrames() {
    this.activeUntil = performance.now() + 400;
    if (this.monitoring) return;
    this.monitoring = true;
    let last = performance.now();
    const tick = t => {
      if (t - last < 1000) this.metrics.frames.push(t - last);
      if (this.metrics.frames.length > 2000) this.metrics.frames.splice(0, 1000);
      last = t;
      if (t < this.activeUntil) requestAnimationFrame(tick);
      else this.monitoring = false;
    };
    requestAnimationFrame(tick);
  }

  // ---------- events ----------

  bind() {
    const sc = this.scroller;
    let settle = 0, idle = 0, lastTop = 0, lastPrefetch = 0;
    sc.addEventListener('scroll', () => {
      if (!this.doc) return;
      const now = performance.now();
      const direction = Math.sign(sc.scrollTop - lastTop);
      lastTop = sc.scrollTop;
      this.trackFrames();
      this.syncPages();
      if (now - lastPrefetch > PREFETCH_EVERY_MS) {
        lastPrefetch = now;
        this.refresh(direction);
      }
      clearTimeout(settle);
      settle = setTimeout(() => {
        // Scrolls we caused ourselves (zoom anchoring, jumps) keep their own measurement.
        if (now > (this.programmaticUntil || 0)) this.startSharp('scroll', now);
        this.refresh();
      }, SETTLE_MS);
      clearTimeout(idle);
      idle = setTimeout(() => this.onIdle?.(this.position()), 600);
      const page = this.currentPage();
      if (page !== this.lastPage) {
        this.lastPage = page;
        this.onPage?.(page);
      }
    }, { passive: true });

    // Trackpad pinch arrives as ctrl+wheel in Chromium: scale the content on the compositor while the
    // fingers move, re-render once they stop.
    sc.addEventListener('wheel', e => {
      if (!e.ctrlKey || !this.doc) return;
      e.preventDefault();
      this.trackFrames();
      const rect = sc.getBoundingClientRect();
      if (!this.gesture) {
        const vx = e.clientX - rect.left, vy = e.clientY - rect.top;
        this.gesture = { scale: 1, x: vx + sc.scrollLeft, y: vy + sc.scrollTop, vx, vy };
        this.content.style.transformOrigin = `${this.gesture.x}px ${this.gesture.y}px`;
      }
      const g = this.gesture;
      g.scale = Math.min(ZOOM_MAX / this.zoom, Math.max(ZOOM_MIN / this.zoom, g.scale * Math.exp(-e.deltaY * 0.01)));
      this.content.style.transform = `scale(${g.scale})`;
      clearTimeout(this.gestureTimer);
      this.gestureTimer = setTimeout(() => this.endGesture(), ZOOM_END_MS);
    }, { passive: false });

    let width = 0;
    new ResizeObserver(() => {
      if (!this.doc || sc.clientWidth === width) return;
      width = sc.clientWidth;
      this.relayoutKeepingAnchor(this.centerAnchor());
      this.refresh();
    }).observe(sc);

    const watchDpr = () => {
      matchMedia(`(resolution: ${dpr()}dppx)`).addEventListener('change', () => {
        if (this.doc) {
          this.relayoutKeepingAnchor(this.centerAnchor());
          this.refresh();
        }
        watchDpr();
      }, { once: true });
    };
    watchDpr();
  }

  endGesture() {
    const g = this.gesture;
    this.gesture = null;
    const anchor = this.anchorAt(g.x, g.y, { x: g.vx, y: g.vy });
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * g.scale));
    this.content.style.transform = '';
    this.relayoutKeepingAnchor(anchor);
    this.startSharp('zoom');
    this.refresh();
    this.onIdle?.(this.position());
  }
}
