import { MAX_CONTEXT_BLOCKS, contextTitle } from '../shared/context-blocks.mjs';

// Assign an unused color once; keep it with the attachment across redraws/remounts.
const CONTEXT_COLORS = ['#396ec2', '#8550ad', '#24805b', '#a56813', '#a94b83', '#72832d', '#287d94', '#b54b48'];
function pinIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M8 14s5-5 5-8a5 5 0 0 0-10 0c0 3 5 8 5 8Z M10 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z');
  svg.append(path); return svg;
}
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
    for (const item of this.items) if (!CONTEXT_COLORS.includes(item.contextColor)) item.contextColor = this.pickColor();
    this.generation = 0;
    this.box = document.getElementById('contextTray');
    this.list = document.getElementById('contextList');
    document.getElementById('contextClear').onclick = () => { this.generation++; this.items = []; this.changed(); };
    this.list.onclick = e => {
      const button = e.target.closest('button'), id = button?.dataset.id;
      if (!id) return;
      if (button.dataset.action === 'remove') this.remove(id);
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
  pickColor() {
    const unused = CONTEXT_COLORS.filter(color => !this.items.some(b => b.contextColor === color));
    const used = this.items.map(b => b.contextColor).filter(color => CONTEXT_COLORS.includes(color));
    const rgb = color => color.match(/[a-f0-9]{2}/gi).map(v => parseInt(v, 16));
    const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
    const scored = unused.map(color => ({ color, gap: used.length ? Math.min(...used.map(other => distance(color, other))) : 1 }));
    // Randomize among well-separated choices so neighboring chips are easy to tell apart.
    const best = Math.max(...scored.map(v => v.gap));
    const choices = scored.filter(v => v.gap >= best * 0.8);
    return choices[Math.floor(Math.random() * choices.length)]?.color || CONTEXT_COLORS[0];
  }
  remove(id) {
    this.items = this.items.filter(b => b.id !== id); this.changed();
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
      item.contextColor = this.pickColor();
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
      node.style.setProperty('--context-color', item.contextColor);
      node.classList.toggle('is-selected', item.id === selected); node.classList.toggle('is-linked', item.id === active);
      Object.assign(node.style, { left: `${(x-rx)/rw*100}%`, top: `${(y-ry)/rh*100}%`, width: `${w/rw*100}%`, height: `${h/rh*100}%` });
      const actions = document.createElement('div'); actions.className = 'context-pin-actions';
      const pin = document.createElement('button'); pin.className = 'context-pin';
      pin.title = pin.ariaLabel = `${contextTitle(item)}，定位对应上下文`;
      pin.append(pinIcon(), document.createTextNode(String(item.contextNumber)));
      pin.onclick = e => { e.stopPropagation(); this.locate(item.id, true); };
      const remove = document.createElement('button'); remove.className = 'context-pin-remove'; remove.textContent = '×';
      remove.title = remove.ariaLabel = `移除${contextTitle(item)}`;
      remove.onclick = e => { e.stopPropagation(); this.remove(item.id); };
      actions.onmouseenter = () => this.emphasize(item.id); actions.onmouseleave = () => this.emphasize(null);
      actions.onfocusin = () => this.emphasize(item.id); actions.onfocusout = () => this.emphasize(null);
      actions.append(pin, remove); node.append(actions); pg.overlay.append(node);
      const scale = pg.el.clientWidth / rw, space = actions.offsetWidth + 6;
      if ((rx + rw - x - w) * scale < space) actions.classList.add((x - rx) * scale >= space ? 'pin-left' : 'pin-above');
    }
  }
  render() {
    this.box.hidden = this.items.length === 0;
    this.list.replaceChildren();
    for (const item of this.items) {
      const row = document.createElement('li'); row.dataset.id = item.id; row.dataset.blockType = item.type;
      row.style.setProperty('--context-color', item.contextColor);
      const label = document.createElement('button'); label.className = 'context-jump'; label.dataset.id = item.id;
      const number = document.createElement('span'); number.className = 'context-number'; number.append(pinIcon(), document.createTextNode(String(item.contextNumber)));
      const page = document.createElement('span'); page.className = 'context-page'; page.textContent = `P${item.page}`;
      label.append(number, page);
      label.setAttribute('aria-label', `定位${contextTitle(item)}`);
      label.title = `${contextTitle(item)}\n${item.title}\n${item.text.slice(0, 160)}`;
      const remove = document.createElement('button'); remove.dataset.id = item.id; remove.dataset.action = 'remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', `移除${contextTitle(item)}`); row.append(label, remove); this.list.append(row);
    }
    document.getElementById('contextCount').textContent = `上下文 ${this.items.length}`;
    document.documentElement.style.setProperty('--context-h', this.items.length ? `${this.box.offsetHeight}px` : '0px');
    this.emphasize(null);
  }
}
