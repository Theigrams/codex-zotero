// The popup for one annotation: color (the user's palette, keys 1–9), comment, delete. Highlight vs. underline is fixed when the
// annotation is made (Zotero refuses to change it). Every change is saved as it is made; the comment when
// it loses focus. The comment shows rendered (Markdown and formulas, mathtext.js); a click edits the source,
// with a live preview while it contains markup; a click on a link in it opens the link. Deleting asks nothing: ⌘Z brings the annotation back.
import { hasMarkup, renderComment } from './mathtext.js';

const $ = id => document.getElementById(id);
const BAR = 28;

export class AnnotationPopup {
  constructor({ layer, openUrl, palette }) {
    this.layer = layer;
    this.palette = palette;
    this.openUrl = openUrl;
    this.key = null;
    this.editing = false;
    this.el = $('annPopup');
    this.comment = $('annComment');
    this.view = $('annCommentView');
    $('annColors').addEventListener('click', e => {
      const b = e.target.closest('button[data-color]');
      if (b) this.setColor(b.dataset.color);
    });
    $('annDelete').addEventListener('click', () => this.trash());
    this.view.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (a) {
        e.preventDefault();
        this.openUrl?.(a.href);
      } else if (!this.view.classList.contains('preview')) {
        this.edit();
      }
    });
    this.comment.addEventListener('focus', () => { this.editing = true; });
    this.comment.addEventListener('input', () => {
      this.grow();
      this.preview();
      this.place();
    });
    this.comment.addEventListener('blur', () => {
      this.saveComment();
      this.editing = false;
      this.show();
    });
    this.comment.addEventListener('keydown', e => {
      if (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.el.addEventListener('mousedown', e => e.stopPropagation());
  }

  get isOpen() {
    return this.key !== null;
  }

  open(key) {
    if (this.key === key) return;
    this.close();
    this.key = key;
    this.editing = false;
    this.layer.keepActive = true;
    this.layer.setActive(key);
    this.comment.value = this.layer.find(key)?.comment || '';
    this.el.hidden = false;
    this.render();
    this.place();
  }

  close() {
    if (this.key === null) return;
    this.saveComment();
    this.key = null;
    this.editing = false;
    this.layer.keepActive = false;
    this.layer.setActive(null);
    this.el.hidden = true;
  }

  // Called whenever the annotation list changes (a refresh from Zotero, or our own write).
  render() {
    if (this.key === null) return;
    const a = this.layer.find(this.key);
    if (!a) {
      this.key = null; // deleted (here or in Zotero): nothing left to save
      this.layer.keepActive = false;
      this.el.hidden = true;
      return;
    }
    // The palette's colors; an annotation in a color outside it (made in Zotero) shows that color too.
    const colors = this.palette().map((c, i) => ({ ...c, title: `${i + 1} · ${c.tag}` }));
    if (!colors.some(c => c.color === a.color)) colors.push({ color: a.color, tag: '', title: '当前颜色（不在设置的颜色里）' });
    const box = $('annColors');
    box.textContent = '';
    for (const c of colors) {
      const b = document.createElement('button');
      b.dataset.color = c.color;
      b.style.setProperty('--c', c.color);
      b.title = c.title;
      b.setAttribute('aria-label', c.tag || c.color);
      b.classList.toggle('on', c.color === a.color);
      box.appendChild(b);
    }
    const kind = { highlight: '', underline: '下划线', image: '区域', note: '便签', ink: '手绘', text: '文字框' }[a.type] ?? a.type;
    $('annMeta').textContent = [`第 ${a.pageLabel} 页`, kind, ...a.tags.filter(Boolean)].filter(Boolean).join(' · ') + (this.error ? ` · ${this.error}` : '');
    if (!this.editing) this.comment.value = a.comment;
    this.show();
  }

  // Rendered comment when there is one and it isn't being edited; otherwise the text box.
  show() {
    const text = this.comment.value;
    const reading = !this.editing && text.trim() !== '';
    this.comment.hidden = reading;
    if (reading) {
      renderComment(this.view, text);
      this.view.hidden = false;
      this.view.classList.remove('preview');
    } else {
      this.preview();
      this.grow();
    }
    this.place();
  }

  preview() {
    const text = this.comment.value;
    const live = this.editing && hasMarkup(text);
    this.view.hidden = !live;
    this.view.classList.toggle('preview', live);
    if (live) renderComment(this.view, text);
  }

  edit() {
    this.editing = true;
    this.show();
    this.comment.focus();
    this.comment.setSelectionRange(this.comment.value.length, this.comment.value.length);
  }

  grow() {
    if (this.comment.hidden) return;
    this.comment.style.height = 'auto';
    this.comment.style.height = `${this.comment.scrollHeight + 2}px`;
  }

  // Under the annotation when there is room, otherwise above it; hidden while it is off screen.
  place() {
    if (this.key === null) return;
    const r = this.layer.clientRect(this.key);
    if (!r || r.bottom < BAR || r.top > window.innerHeight) {
      this.el.style.visibility = 'hidden';
      return;
    }
    this.el.style.visibility = '';
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const below = r.bottom + 6;
    const top = below + h <= window.innerHeight - 4 || r.top - h - 6 < BAR + 4 ? Math.min(below, window.innerHeight - h - 4) : r.top - h - 6;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left));
    this.el.style.top = `${Math.max(BAR + 4, top)}px`;
    this.el.style.left = `${left}px`;
  }

  async run(write) {
    this.error = '';
    try {
      await write();
    } catch (e) {
      this.error = e.message;
      this.render();
    }
  }

  setColor(color) {
    if (this.key !== null) this.run(() => this.layer.update(this.key, { color }));
  }

  saveComment() {
    const a = this.key !== null && this.layer.find(this.key);
    if (a && this.comment.value !== a.comment) {
      const key = this.key;
      this.run(() => this.layer.update(key, { comment: this.comment.value }));
    }
  }

  trash() {
    const key = this.key;
    if (key === null) return;
    this.comment.value = this.layer.find(key)?.comment || ''; // don't save a half-typed comment on the way out
    this.close();
    this.layer.remove(key).catch(() => {});
  }
}
