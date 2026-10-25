import { BLOCK_NAMES, MAX_CONTEXT_BLOCKS } from '../shared/context-blocks.mjs';
export class ContextBlocks {
  constructor({ host, reader, selection, onChange, onNote }) {
    Object.assign(this, { host, reader, selection, onChange, onNote });
    const initial = host.extensions?.modelContext?.getCurrent();
    const saved = initial?.structuredContent?.contextBlocks;
    this.items = Array.isArray(saved) ? saved.filter(b => b && typeof b.id === 'string' && typeof b.docId === 'string'
      && typeof b.title === 'string' && Number.isInteger(b.page) && b.page > 0 && Array.isArray(b.rect) && b.rect.length === 4 && b.rect.every(Number.isFinite))
      .slice(0, MAX_CONTEXT_BLOCKS).map(b => {
        const src = initial.content?.find(c => c.type === 'text' && c._meta?.['zotero/blockId'] === b.id)?._meta?.['openai/thumbnail']?.src;
        return { ...b, text: String(b.text || '').slice(0,6000), ...(typeof src === 'string' && src.startsWith('data:image/png;base64,') && src.length < 1024*1024 ? { image:src.split(',')[1] } : {}) };
      }) : [];
    this.generation = 0;
    this.box = document.getElementById('contextTray');
    this.list = document.getElementById('contextList');
    document.getElementById('contextClear').onclick = () => { this.generation++; this.items = []; this.changed(); };
    this.list.onclick = e => { const id = e.target.closest('button')?.dataset.id; if (id) { this.items = this.items.filter(b => b.id !== id); this.changed(); } };
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
      this.items.push(item); this.changed(); this.onNote('已加入上下文');
    } catch (e) { this.onNote(`加入失败：${e.message}`); }
    finally { this.adding = false; }
  }
  changed(publish = true) { this.render(); if (publish) this.onChange(); }
  render() {
    this.box.hidden = this.items.length === 0;
    this.list.replaceChildren();
    for (const item of this.items) {
      const row = document.createElement('li');
      const label = document.createElement('span'); label.textContent = `第 ${item.page} 页 · ${BLOCK_NAMES[item.type] || '选段'}`;
      label.title = `${item.title}\n${item.text.slice(0, 160)}`;
      const remove = document.createElement('button'); remove.dataset.id = item.id; remove.textContent = '×';
      remove.setAttribute('aria-label', `移除${label.textContent}`); row.append(label, remove); this.list.append(row);
    }
    document.getElementById('contextCount').textContent = `上下文 ${this.items.length}`;
    document.documentElement.style.setProperty('--context-h', this.items.length ? `${this.box.offsetHeight}px` : '0px');
  }
}
