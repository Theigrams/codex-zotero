// The annotation drawer (A): this paper's annotations by position, filtered by tag; click to jump.
// Writes that could not be saved show here and only here.
import { renderComment } from './mathtext.js';
import { timing } from './timing.js';

const $ = id => document.getElementById(id);
const KIND = { image: '区域（图或公式）', note: '便签', ink: '手绘', text: '文字框' };
const UNTAGGED = '\u0000none';

export class AnnotationDrawer {
  // listNotes() → { notes, map: { status, error, available } }; onNote(key): open a note in a tab;
  // generateMap(): ask for the paper map (made only on request).
  // palette(): the user's colors and tags, so a tag chip shows its color.
  constructor({ layer, onJump, listNotes, onNote, generateMap, openUrl, palette }) {
    Object.assign(this, { layer, onJump, listNotes, onNote, generateMap, openUrl, palette });
    this.notes = [];
    this.map = null;
    this.mapTimer = 0;
    this.el = $('annDrawer');
    this.filter = null; // a tag, UNTAGGED, or null for all
    $('drawerClose').addEventListener('click', () => this.close());
    $('drawerFilter').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const tag = b.dataset.tag ?? null;
      this.filter = tag === this.filter ? null : tag;
      this.render();
    });
    $('drawerList').addEventListener('click', e => {
      const link = e.target.closest('a[href]');
      if (link) {
        e.preventDefault();
        return this.openUrl?.(link.href);
      }
      const li = e.target.closest('li[data-key]');
      const a = li && this.layer.find(li.dataset.key);
      if (a) this.onJump(a);
    });
    $('drawerNotes').addEventListener('click', e => {
      if (e.target.closest('button[data-map]')) {
        this.map = { ...this.map, status: 'running', error: '' };
        this.render();
        this.generateMap().then(() => this.loadNotes()).catch(err => {
          this.map = { ...this.map, status: 'failed', error: err.message };
          this.render();
        });
        return;
      }
      const li = e.target.closest('li[data-key]');
      if (li) this.onNote(li.dataset.key);
    });
    $('drawerWrites').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) this.layer.retry(b.dataset.id, b.dataset.discard === '1').catch(() => {});
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.notes = [];
    this.map = null;
    this.render();
    this.loadNotes();
  }

  // Notes and the map's state; while a map is being made, checks again every few seconds.
  loadNotes() {
    clearTimeout(this.mapTimer);
    const doc = this.layer.doc;
    return this.listNotes().then(r => {
      if (this.layer.doc !== doc || !this.isOpen) return;
      this.notes = r.notes;
      this.map = r.map;
      this.render();
      if (r.map?.status === 'running') this.mapTimer = setTimeout(() => this.loadNotes(), timing.mapPollMs);
    }).catch(() => {});
  }

  close() {
    this.el.hidden = true;
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  render() {
    if (!this.isOpen) return;
    const L = this.layer;
    const items = L.items;
    $('drawerCount').textContent = items.length ? String(items.length) : '';

    // Notes, the paper map first; below them the map's button or state.
    const notes = $('drawerNotes');
    notes.textContent = '';
    const isMap = n => n.title.startsWith('论文地图');
    const sorted = [...this.notes.filter(isMap), ...this.notes.filter(n => !isMap(n))];
    if (sorted.length || this.map?.available) {
      const h = document.createElement('h3');
      h.textContent = '笔记';
      const ol = document.createElement('ol');
      for (const n of sorted) {
        const li = document.createElement('li');
        li.dataset.key = n.key;
        li.textContent = n.title;
        li.title = '在新标签中打开';
        ol.appendChild(li);
      }
      notes.append(h, ol);
      // Only while there is no map yet: once it exists nothing invites a regeneration (ask Codex for that).
      if (this.map?.available && !sorted.some(isMap)) {
        const row = document.createElement('div');
        row.className = 'mapRow';
        if (this.map.status === 'running') {
          row.textContent = this.map.stage ? `论文地图：${this.map.stage}后生成…` : '论文地图生成中…（约一两分钟）';
        } else {
          if (this.map.status === 'failed') {
            const why = document.createElement('small');
            why.textContent = `生成失败：${this.map.error}`;
            row.appendChild(why);
          }
          const b = document.createElement('button');
          b.dataset.map = '1';
          b.textContent = this.map.status === 'failed' ? '重试' : '生成论文地图';
          b.title = '由 gpt-6.1-sol 读全文，写一份带页码的导航地图，存为 Zotero 笔记（会把正文发给云端模型）';
          row.appendChild(b);
        }
        notes.appendChild(row);
      }
    }

    // Tags actually used in this paper, most used first.
    const counts = new Map();
    for (const a of items) for (const t of a.tags) counts.set(t, (counts.get(t) || 0) + 1);
    const untagged = items.filter(a => !a.tags.length).length;
    if (this.filter && this.filter !== UNTAGGED && !counts.has(this.filter)) this.filter = null;
    const filter = $('drawerFilter');
    filter.textContent = '';
    // A tag's color: the palette's, else the color most annotations with that tag have.
    const colorOf = tag => {
      const p = this.palette?.().find(c => c.tag === tag);
      if (p) return p.color;
      const n = new Map();
      for (const a of items) if (a.tags.includes(tag)) n.set(a.color, (n.get(a.color) || 0) + 1);
      return [...n].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    };
    const button = (label, tag) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (tag !== null) b.dataset.tag = tag;
      const color = tag !== null && tag !== UNTAGGED && colorOf(tag);
      if (color) {
        b.classList.add('dot');
        b.style.setProperty('--c', color);
      }
      b.classList.toggle('on', tag === this.filter);
      filter.appendChild(b);
    };
    button('全部', null);
    for (const [t, n] of [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'zh'))) button(`${t} ${n}`, t);
    if (untagged && counts.size) button(`无标签 ${untagged}`, UNTAGGED);

    // Zotero unreachable and writes waiting are both worth knowing; neither hides the other.
    $('drawerNote').textContent = !L.available ? '这篇 PDF 不是从 Zotero 打开的，没有批注。'
      : [L.error && `${L.error}；显示的是上次读到的批注。`, L.pending && `${L.pending} 条正在写入 Zotero…`].filter(Boolean).join(' ')
        || (items.length ? '' : '还没有批注。选中文字后按 H 高亮。');

    const writes = $('drawerWrites');
    writes.textContent = '';
    for (const w of L.writes) {
      const d = document.createElement('div');
      const head = document.createElement('span');
      head.textContent = `${w.label}${w.status === 'conflict' ? '未覆盖' : '未写入'}${w.page ? ` · 第 ${w.page} 页` : ''}${w.text ? ` · ${w.text}` : ''}`;
      const why = document.createElement('small');
      why.textContent = w.error;
      d.append(head, why);
      const act = (label, discard) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.id = w.id;
        b.dataset.discard = discard ? '1' : '0';
        d.appendChild(b);
      };
      if (w.status === 'failed') act('重试', false);
      act(w.status === 'conflict' ? '放弃我的修改' : '放弃', true);
      writes.appendChild(d);
    }

    const list = $('drawerList');
    list.textContent = '';
    const shown = items.filter(a => !this.filter || (this.filter === UNTAGGED ? !a.tags.length : a.tags.includes(this.filter)));
    for (const a of shown) {
      const li = document.createElement('li');
      li.dataset.key = a.key;
      li.style.setProperty('--c', a.color);
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = a.text || KIND[a.type] || a.type;
      const p = document.createElement('span');
      p.className = 'p';
      p.textContent = a.pageLabel;
      const c = document.createElement('span');
      c.className = 'c md';
      renderComment(c, a.comment);
      li.append(t, p, c);
      list.appendChild(li);
    }
  }
}
