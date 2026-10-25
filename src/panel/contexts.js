import { BLOCK_NAMES, MAX_CONTEXT_BLOCKS, contextTitle } from '../shared/context-blocks.mjs';
export class ContextBlocks {
  constructor({ host, reader, selection, onChange, onNote, onNavigate }) {
    Object.assign(this, { host, reader, selection, onChange, onNote, onNavigate });
    const initial = host.extensions?.modelContext?.getCurrent();
    const saved = initial?.structuredContent?.contextBlocks;
    this.items = Array.isArray(saved) ? saved.filter(b => b && typeof b.id === 'string' && typeof b.docId === 'string'
      && typeof b.title === 'string' && Number.isInteger(b.page) && b.page > 0 && Array.isArray(b.rect) && b.rect.length === 4 && b.rect.every(Number.isFinite))
      .slice(0, MAX_CONTEXT_BLOCKS).map(b => {
        const src = initial.content?.find(c => c.type === 'text' && c._meta?.['zotero/blockId'] === b.id)?._meta?.['openai/thumbnail']?.src;
        return { ...b, text: String(b.text || '').slice(0,6000), ...(typeof src === 'string' && src.startsWith('data:image/png;base64,') && src.length < 1024*1024 ? { image:src.split(',')[1] } : {}) };
      }) : [];
    this.nextNumber = Math.max(0, ...this.items.map(b => Number.isSafeInteger(b.contextNumber) && b.contextNumber > 0 ? b.contextNumber : 0)) + 1;
    for (const item of this.items) if (!Number.isSafeInteger(item.contextNumber) || item.contextNumber < 1) item.contextNumber = this.nextNumber++;
    this.generation = 0;
    this.box = document.getElementById('contextTray');
    this.list = document.getElementById('contextList');
    document.getElementById('contextClear').onclick = () => { this.generation++; this.items = []; this.changed(); };
    this.list.onclick = e => {
      const button = e.target.closest('button'), id = button?.dataset.id;
      if (!id) return;
      if (button.dataset.action === 'remove') { this.items = this.items.filter(b => b.id !== id); this.changed(); }
      else this.locate(id);
    };
    this.list.addEventListener('mouseover', e => this.emphasize(e.target.closest('li')?.dataset.id));
    this.list.addEventListener('mouseleave', () => this.emphasize(null));
    this.list.addEventListener('focusin', e => this.emphasize(e.target.closest('li')?.dataset.id));
    this.list.addEventListener('focusout', () => this.emphasize(null));
    host.app?.addEventListener('hostcontextchanged', context => {
      if (!Object.hasOwn(context, 'openai/modelContext')) return;
      const state = context['openai/modelContext'];
      if (state == null) { if (this.items.length) { this.generation++; this.items = []; this.changed(); } return; }
      const ids = new Set((state.content || []).filter(b => b.type === 'text').map(b => b._meta?.['zotero/blockId']).filter(Boolean));
      // Host notifications acknowledging our own update don't need to publish again.
      const kept = this.items.filter(b => ids.has(b.id));
      if (kept.length !== this.items.length) { this.items = kept; this.changed(); }
    });
    this.render();
  }
  async add() {
    if (this.adding) return;
    const s = this.selection.current, doc = this.reader.doc;
    if (!s || !doc) return;
    const rect = [...this.selection.bounds()];
    const id = `${doc.id}:${s.page}:${rect.map(v => Math.round(v)).join(',')}`;
    if (this.items.some(b => b.id === id)) return this.onNote('这一块已在上下文中');
    if (this.items.length >= MAX_CONTEXT_BLOCKS) return this.onNote(`最多保留 ${MAX_CONTEXT_BLOCKS} 块，请先移除一些`);
    const item = { id, docId: doc.id, title: doc.title, itemKey: doc.itemKey, page: s.page, rect,
      type: s.block?.type || (s.kind === 'text' ? 'text' : 'region'), text: (s.text || '').slice(0, 6000), source: s.block?.textSource || 'original' };
    const generation = this.generation;
    this.adding = true;
    try {
      const crop = await this.host.call('selection_image', { docId: doc.id, page: s.page, rect, scale: 0.6 });
      if (generation !== this.generation) return;
      if (crop.data.length <= 1024*1024) item.image = crop.data;
      item.contextNumber = this.nextNumber++;
      this.items.push(item); this.changed(); this.onNote('已加入上下文');
    } catch (e) { this.onNote(`加入失败：${e.message}`); }
    finally { this.adding = false; }
  }
  selectedId() {
    const sel = this.selection.current, rect = sel && this.selection.bounds();
    return rect ? this.items.find(b => b.docId === this.reader.doc?.id && b.page === sel.page
      && b.rect.every((v, i) => Math.abs(v - rect[i]) < 1))?.id : null;
  }
  emphasize(id) {
    this.hoverId = id;
    const active = id || this.selectedId();
    for (const row of this.list.children) row.classList.toggle('is-linked', row.dataset.id === active);
    for (const node of this.reader.content.querySelectorAll('.context-mark')) node.classList.toggle('is-linked', node.dataset.id === active);
  }
  async locate(id, focusTray = false) {
    const item = this.items.find(b => b.id === id); if (!item) return;
    const request = this.navigation = (this.navigation || 0) + 1;
    try {
      await this.onNavigate?.(item);
      if (request !== this.navigation || !this.items.includes(item) || this.reader.doc?.id !== item.docId) return;
      this.selection.set({ kind: 'region', page: item.page, rect: item.rect, text: item.text,
        block: { type: item.type, textSource: item.source } });
      this.emphasize(id);
      if (focusTray) {
        const row = [...this.list.children].find(n => n.dataset.id === id);
        row?.querySelector('.context-jump')?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    } catch (e) { this.onNote(`定位失败：${e.message}`); }
  }
  selectionChanged() { this.redraw(); this.emphasize(this.hoverId); }
  changed(publish = true) { this.render(); this.redraw(); if (publish) this.onChange(); }
  relayout() {
    const geometry = `${this.reader.doc?.id}:${this.reader.crop}:${this.reader.zoom}:${this.reader.scroller.clientWidth}`;
    if (geometry !== this.geometry) { this.geometry = geometry; this.redraw(); }
  }
  redraw() { for (const page of this.reader.pages.keys()) this.draw(page); }
  draw(page) {
    const pg = this.reader.pages.get(page); if (!pg) return;
    pg.overlay.querySelectorAll('.context-mark').forEach(n => n.remove());
    const selected = this.selectedId(), active = this.hoverId || selected;
    const [rx, ry, rw, rh] = this.reader.region(page - 1);
    for (const item of this.items.filter(b => b.docId === this.reader.doc?.id && b.page === page)) {
      const [x,y,w,h] = item.rect;
      const node = document.createElement('div'); node.className = 'context-mark';
      node.dataset.id = item.id; node.dataset.blockType = item.type;
      node.classList.toggle('is-selected', item.id === selected); node.classList.toggle('is-linked', item.id === active);
      Object.assign(node.style, { left: `${(x-rx)/rw*100}%`, top: `${(y-ry)/rh*100}%`, width: `${w/rw*100}%`, height: `${h/rh*100}%` });
      const pin = document.createElement('button'); pin.className = 'context-pin';
      const scale = pg.el.clientWidth / rw;
      if ((rx + rw - x - w) * scale < 40) pin.classList.add((x - rx) * scale >= 40 ? 'pin-left' : 'pin-above');
      pin.title = pin.ariaLabel = `${contextTitle(item)}，定位对应上下文`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox','0 0 16 16'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor'); svg.setAttribute('aria-hidden','true');
      const path = document.createElementNS(svg.namespaceURI,'path');
      path.setAttribute('d','M8 14s5-5 5-8a5 5 0 0 0-10 0c0 3 5 8 5 8Z M10 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z');
      svg.append(path); pin.append(svg, document.createTextNode(String(item.contextNumber)));
      pin.onclick = e => { e.stopPropagation(); this.locate(item.id, true); };
      pin.onmouseenter = () => this.emphasize(item.id); pin.onmouseleave = () => this.emphasize(null);
      pin.onfocus = () => this.emphasize(item.id); pin.onblur = () => this.emphasize(null);
      node.append(pin); pg.overlay.append(node);
    }
  }
  render() {
    this.box.hidden = this.items.length === 0;
    this.list.replaceChildren();
    for (const item of this.items) {
      const row = document.createElement('li'); row.dataset.id = item.id; row.dataset.blockType = item.type;
      const label = document.createElement('button'); label.className = 'context-jump'; label.dataset.id = item.id;
      const number = document.createElement('span'); number.className = 'context-number'; number.textContent = `上下文 ${item.contextNumber}`;
      label.append(number, document.createTextNode(`第 ${item.page} 页 · ${BLOCK_NAMES[item.type] || '选段'}`));
      label.setAttribute('aria-label', `定位${contextTitle(item)}`);
      label.title = `${item.title}\n${item.text.slice(0, 160)}`;
      const remove = document.createElement('button'); remove.dataset.id = item.id; remove.dataset.action = 'remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', `移除${contextTitle(item)}`); row.append(label, remove); this.list.append(row);
    }
    document.getElementById('contextCount').textContent = `上下文 ${this.items.length}`;
    document.documentElement.style.setProperty('--context-h', this.items.length ? `${this.box.offsetHeight}px` : '0px');
    this.emphasize(null);
  }
}
