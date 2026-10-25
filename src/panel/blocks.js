// Hover outlines stay on the page overlay (pointer-events:none), preserving word/drag selection.
import { BLOCK_NAMES } from '../shared/context-blocks.mjs';
export class Blocks {
  constructor({ reader, selection, call, enabled, onNote, onAdd }) {
    Object.assign(this, { reader, selection, call, enabled, onNote, onAdd });
    this.pages = new Map(); this.generation = 0;
    reader.content.addEventListener('mousemove', e => this.hover(e));
    reader.content.addEventListener('mouseleave', () => this.outline(null));
  }
  reset() { this.generation++; this.pages.clear(); this.outline(null); }
  async prefetch(pages) {
    if (!this.reader.doc || !this.enabled()) return;
    const id = this.reader.doc.id, generation = this.generation;
    for (const page of pages) {
      const key = `${id}:${page}`;
      if (this.pages.has(key)) continue;
      this.pages.set(key, null);
      try {
        const result = await this.call('layout_page', { docId: id, page });
        if (this.reader.doc?.id !== id || this.generation !== generation) return;
        this.pages.set(key, result);
        if (result.notice) this.onNote(result.notice);
      } catch (error) { this.pages.delete(key); if (this.reader.doc?.id === id) this.onNote(error.message); }
    }
  }
  hit(page, point) {
    if (!this.enabled() || !this.reader.doc) return null;
    const blocks = this.pages.get(`${this.reader.doc.id}:${page}`)?.blocks || [];
    return blocks.filter(b => point[0] >= b.rect[0] && point[0] <= b.rect[0]+b.rect[2] && point[1] >= b.rect[1] && point[1] <= b.rect[1]+b.rect[3])
      .sort((a,b) => a.rect[2]*a.rect[3] - b.rect[2]*b.rect[3])[0];
  }
  hover(e) {
    if (e.buttons || !this.enabled()) return this.outline(null);
    const page = e.target.closest('.page');
    if (!page || !this.reader.doc) return this.outline(null);
    const k = Number(page.dataset.page), point = this.selection.pointAt(e, page, k);
    this.outline(this.hit(k, point), k);
  }
  outline(block, page) {
    this.hoverNode?.remove(); this.hoverNode = null;
    if (!block || this.selection.drag) return;
    const selected = this.selection.current;
    if (selected?.page === page && selected.kind === 'region'
      && selected.rect.every((v, i) => Math.abs(v - block.rect[i]) < 1)) return;
    const pg = this.reader.pages.get(page);
    if (!pg) return;
    const [rx, ry, rw, rh] = this.reader.region(page-1), [x,y,w,h] = block.rect;
    const n = document.createElement('div'); n.className = 'block-outline'; n.dataset.blockType = block.type;
    Object.assign(n.style, { left: `${(x-rx)/rw*100}%`, top: `${(y-ry)/rh*100}%`, width: `${w/rw*100}%`, height: `${h/rh*100}%` });
    const tag = document.createElement('span'); tag.textContent = BLOCK_NAMES[block.type] || '段落'; n.append(tag);
    pg.overlay.append(n); this.hoverNode = n;
  }
  select(page, point, event) {
    const block = this.hit(page, point);
    if (!block) return false;
    this.outline(null);
    this.selection.set({ kind: 'region', page, rect: block.rect, text: block.text,
      block: { id: block.id, type: block.type, textSource: block.textSource || 'original' } });
    if (event?.shiftKey) this.onAdd();
    return true;
  }
}
