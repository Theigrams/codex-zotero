// The settings drawer (⌘,): render mode, the annotation palette (colors and tags; the row tagged 问答 is for AI answers),
// keyboard shortcuts, the paper map's model and prompt, and the reading questions guided reading follows. Every change is saved at once (prefs_set).
import { DEFAULT_PALETTE, ZOTERO_COLORS } from '../shared/annotations.mjs';
import { ACTIONS, DEFAULT_KEYS, comboOf, keymap, reserved, showCombo } from '../shared/keys.mjs';
import { MAP_PROMPT } from '../server/map-prompt.mjs';
import { DEFAULT_QUESTIONS, parseTemplate } from '../server/reading-questions.mjs';

const $ = id => document.getElementById(id);
const MAX_COLORS = 9;

export class Settings {
  // getPrefs(): the current preferences; onChange(prefs): after a save.
  constructor({ call, getPrefs, onChange }) {
    Object.assign(this, { call, getPrefs, onChange });
    this.el = $('settings');
    this.capturing = null; // action id waiting for a new combo
    this.picking = -1;     // palette row whose color is being picked
    for (const input of document.querySelectorAll('input[name="renderMode"]')) {
      input.addEventListener('change', () => input.checked && this.save({ renderMode: input.value }));
    }
    $('paletteAdd').addEventListener('click', () => this.addColor());
    $('paletteReset').addEventListener('click', () => this.save({ palette: null }, 'paletteNote'));
    $('paletteList').addEventListener('click', e => this.paletteClick(e));
    $('paletteList').addEventListener('change', e => this.paletteChange(e));
    $('swatches').addEventListener('click', e => this.pickColor(e));
    this.el.addEventListener('click', e => {
      if (!e.target.closest('#swatches, #paletteList .sw')) $('swatches').hidden = true;
    });
    $('keyList').addEventListener('click', e => {
      const b = e.target.closest('button[data-action]');
      if (b) this.capture(b.dataset.action);
    });
    $('keysReset').addEventListener('click', () => this.save({ keys: {} }, 'keysNote'));
    // Capture phase: a new combo must not also trigger whatever it is bound to.
    window.addEventListener('keydown', e => this.captureKey(e), true);
    $('mapModel').addEventListener('change', () => this.save({ mapModel: $('mapModel').value.trim() }, 'mapNote'));
    $('mapEffort').addEventListener('change', () => this.save({ mapEffort: $('mapEffort').value }, 'mapNote'));
    $('mapPrompt').addEventListener('change', () => {
      const v = $('mapPrompt').value;
      this.save({ mapPrompt: v.trim() === MAP_PROMPT.trim() ? '' : v }, 'mapNote');
    });
    $('mapReset').addEventListener('click', () => this.save({ mapPrompt: '' }, 'mapNote'));
    $('noteTemplate').addEventListener('change', () => {
      const v = $('noteTemplate').value;
      try {
        if (v.trim()) parseTemplate(v);
      } catch (e) {
        $('noteNote').textContent = e.message; // what was typed stays, to be corrected
        return;
      }
      this.save({ readingQuestions: v.trim() === DEFAULT_QUESTIONS.trim() ? '' : v }, 'noteNote');
    });
    $('noteReset').addEventListener('click', () => this.save({ readingQuestions: '' }, 'noteNote'));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.render();
    this.el.hidden = false;
  }

  close() {
    this.capturing = null;
    $('swatches').hidden = true;
    this.el.hidden = true;
  }

  async save(patch, noteId) {
    if (noteId) $(noteId).textContent = '';
    this.refused = null;
    try {
      const { prefs } = await this.call('prefs_set', patch);
      this.onChange(prefs);
    } catch (e) {
      if (noteId) $(noteId).textContent = e.message;
      this.refused = noteId; // a refused text keeps what was typed, so it can be corrected
    }
    this.render();
  }

  render() {
    const p = this.getPrefs();
    for (const input of document.querySelectorAll('input[name="renderMode"]')) input.checked = input.value === p.renderMode;
    this.renderPalette(p.palette || DEFAULT_PALETTE);
    this.renderKeys(keymap(p.keys));
    $('mapModel').value = p.mapModel || '';
    $('mapEffort').value = p.mapEffort || '';
    if (document.activeElement !== $('mapPrompt') && this.refused !== 'mapNote') $('mapPrompt').value = p.mapPrompt || MAP_PROMPT;
    if (document.activeElement !== $('noteTemplate') && this.refused !== 'noteNote') $('noteTemplate').value = p.readingQuestions || DEFAULT_QUESTIONS;
  }

  // ---------- palette ----------

  renderPalette(palette) {
    const list = $('paletteList');
    list.textContent = '';
    palette.forEach((c, i) => {
      const li = document.createElement('li');
      li.dataset.i = i;
      li.innerHTML = `<span class="n">${i + 1}</span><button class="sw" title="换颜色" aria-label="换颜色"></button>`
        + '<input type="text" maxlength="30" aria-label="标签">'
        + `<button class="del" title="删除" aria-label="删除"${palette.length <= 1 ? ' disabled' : ''}>✕</button>`;
      li.querySelector('.sw').style.setProperty('--c', c.color);
      li.querySelector('input[type=text]').value = c.tag;
      list.appendChild(li);
    });
    $('paletteAdd').hidden = palette.length >= MAX_COLORS;
    this.palette = palette.map(c => ({ ...c }));
  }

  paletteClick(e) {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (e.target.closest('.del')) {
      return this.save({ palette: this.palette.filter((_, j) => j !== i) }, 'paletteNote');
    }
    if (e.target.closest('.sw')) {
      this.picking = i;
      const box = $('swatches');
      box.textContent = '';
      const used = new Set(this.palette.map(c => c.color));
      for (const color of ZOTERO_COLORS) {
        const b = document.createElement('button');
        b.dataset.color = color;
        b.style.setProperty('--c', color);
        b.title = used.has(color) && color !== this.palette[i].color ? '已在使用' : color;
        b.disabled = used.has(color) && color !== this.palette[i].color;
        box.appendChild(b);
      }
      const r = e.target.getBoundingClientRect(), d = this.el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left - d.left}px`, top: `${r.bottom - d.top + this.el.scrollTop + 4}px` });
      box.hidden = false;
    }
  }

  pickColor(e) {
    const b = e.target.closest('button[data-color]');
    $('swatches').hidden = true;
    if (!b || this.picking < 0) return;
    const next = this.palette.map((c, j) => (j === this.picking ? { ...c, color: b.dataset.color } : c));
    this.picking = -1;
    this.save({ palette: next }, 'paletteNote');
  }

  paletteChange(e) {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (e.target.type !== 'text') return;
    this.save({ palette: this.palette.map((c, j) => (j === i ? { ...c, tag: e.target.value.trim() } : c)) }, 'paletteNote');
  }

  addColor() {
    const used = new Set(this.palette.map(c => c.color));
    const color = ZOTERO_COLORS.find(c => !used.has(c));
    if (!color) {
      $('paletteNote').textContent = 'Zotero 的预设颜色已经用完。';
      return;
    }
    let n = this.palette.length + 1;
    while (this.palette.some(c => c.tag === `标签${n}`)) n++;
    this.save({ palette: [...this.palette, { color, tag: `标签${n}` }] }, 'paletteNote');
  }

  // ---------- shortcuts ----------

  renderKeys(map) {
    const list = $('keyList');
    list.textContent = '';
    for (const a of ACTIONS) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = a.label;
      const b = document.createElement('button');
      b.dataset.action = a.id;
      b.textContent = this.capturing === a.id ? '按下组合键…' : showCombo(map[a.id]);
      b.classList.toggle('capturing', this.capturing === a.id);
      li.append(name, b);
      list.appendChild(li);
    }
  }

  capture(id) {
    this.capturing = this.capturing === id ? null : id;
    $('keysNote').textContent = '';
    this.renderKeys(keymap(this.getPrefs().keys));
  }

  captureKey(e) {
    if (!this.capturing || !this.isOpen) return;
    const combo = comboOf(e);
    if (!combo) return;
    e.preventDefault();
    e.stopPropagation();
    const id = this.capturing;
    this.capturing = null;
    if (combo === 'Escape') return this.renderKeys(keymap(this.getPrefs().keys));
    if (reserved(combo)) {
      $('keysNote').textContent = `${showCombo(combo)} 是固定功能，不能分配。`;
      return this.renderKeys(keymap(this.getPrefs().keys));
    }
    // A combo already in use moves: the other action gets this one's old combo.
    const map = keymap(this.getPrefs().keys);
    const other = Object.keys(map).find(k => k !== id && map[k] === combo);
    const next = { ...map, [id]: combo, ...(other ? { [other]: map[id] } : {}) };
    const overrides = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== DEFAULT_KEYS[k]));
    this.save({ keys: overrides }, 'keysNote');
  }
}
