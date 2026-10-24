// Home: shown when no paper is open (or after +). A Zotero search box and the papers being read,
// each one click (or ↑↓ and return) from where it was left.

const $ = id => document.getElementById(id);

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} 天前` : new Date(ms).toLocaleDateString('zh-CN');
}

export class Home {
  // onOpen({ docId } | { itemKey }); onLeave(): back to the paper that was open, if any.
  constructor({ call, onOpen, onLeave }) {
    Object.assign(this, { call, onOpen, onLeave });
    this.rows = [];
    this.cur = 0;
    this.token = 0;
    this.timer = 0;
    $('search').addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load($('search').value), 250);
    });
    $('search').addEventListener('keydown', e => this.key(e));
    $('homeList').addEventListener('click', e => {
      const li = e.target.closest('li');
      if (li) this.pick(Number(li.dataset.i));
    });
  }

  get isOpen() {
    return !$('home').hidden;
  }

  show() {
    $('home').hidden = false;
    $('search').value = '';
    this.load('');
    $('search').focus();
  }

  hide() {
    $('home').hidden = true;
  }

  async load(query) {
    const token = ++this.token;
    $('homeNote').textContent = '';
    let r;
    try {
      r = await this.call('home_list', { query });
    } catch (e) {
      if (token === this.token) $('homeNote').textContent = e.message;
      return;
    }
    if (token !== this.token) return;
    const searching = !!query.trim();
    $('homeHeading').textContent = searching ? 'Zotero' : '在读';
    this.rows = searching
      ? r.results.map(x => ({ open: { itemKey: x.key }, title: x.title, meta: [x.creators, x.year].filter(Boolean).join(' · ') }))
      : r.recent.map(x => ({ open: { docId: x.id }, title: x.title, meta: [x.page && x.pageCount ? `第 ${x.page} / ${x.pageCount} 页` : x.page ? `第 ${x.page} 页` : '', ago(x.lastRead)].filter(Boolean).join(' · ') }));
    if (!this.rows.length) $('homeNote').textContent = searching ? '没有找到。' : '还没有读过的论文。在上面搜索，或在对话里让 Codex 打开一篇。';
    this.cur = 0;
    this.render();
  }

  render() {
    const list = $('homeList');
    list.textContent = '';
    this.rows.forEach((row, i) => {
      const li = document.createElement('li');
      li.dataset.i = i;
      li.classList.toggle('cur', i === this.cur);
      const b = document.createElement('b');
      b.textContent = row.title;
      const small = document.createElement('small');
      small.textContent = row.meta;
      li.append(b, small);
      list.appendChild(li);
    });
  }

  key(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.rows.length) return;
      this.cur = (this.cur + (e.key === 'ArrowDown' ? 1 : -1) + this.rows.length) % this.rows.length;
      this.render();
      $('homeList').children[this.cur]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.pick(this.cur);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.onLeave();
    }
  }

  pick(i) {
    const row = this.rows[i];
    if (row) this.onOpen(row.open);
  }

  note(text) {
    $('homeNote').textContent = text;
  }
}
