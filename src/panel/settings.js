// The settings drawer (⌘,): render mode, the annotation palette (colors and tags; the row tagged 问答 is for AI answers),
// keyboard shortcuts, the paper map's model and prompt, enhanced recognition (switch, official and self-hosted MinerU — kept
// in the keychain by the server, never sent back), and the reading questions guided reading follows. Every change is saved at once (prefs_set).
import { DEFAULT_PALETTE, ZOTERO_COLORS } from '../shared/annotations.mjs';
import { ACTIONS, DEFAULT_KEYS, comboOf, keymap, reserved, showCombo } from '../shared/keys.mjs';
import { MAP_PROMPT } from '../server/map-prompt.mjs';
import { DEFAULT_QUESTIONS, parseTemplate } from '../server/reading-questions.mjs';

const $ = id => document.getElementById(id);

// The same rule as the server (state.mjs): the key travels with every request, so plain http only to this machine.
function selfUrlProblem(v) {
  if (!v) return '';
  let u;
  try { u = new URL(v); } catch { return '自部署 MinerU 的地址无效。'; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  return u.protocol === 'https:' || (u.protocol === 'http:' && loopback) ? '' : '自部署 MinerU 的地址应以 https://（本机服务可用 http://）开头。';
}
const MAX_COLORS = 9;

const EYE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">'
  + '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path class="shut" d="M2.5 2.5l11 11"/></svg>';

// The eye beside a key field (span.secret): shows what is being typed, or hides it again. It keeps the focus in
// the field, so showing the key doesn't save it half typed.
export function bindEye(box) {
  const input = box.querySelector('input'), eye = box.querySelector('.eye');
  eye.innerHTML = EYE;
  eye.addEventListener('mousedown', e => e.preventDefault());
  eye.addEventListener('click', e => {
    e.preventDefault();
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    box.classList.toggle('shown', show);
  });
}

export const hideKey = input => {
  input.type = 'password';
  input.closest('.secret')?.classList.remove('shown');
};

export class Settings {
  // getPrefs(): the current preferences; onChange(prefs): after a save; toast(text, ok): a passing notice.
  constructor({ call, getPrefs, onChange, toast }) {
    Object.assign(this, { call, getPrefs, onChange, toast });
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
    const rec = patch => this.save({ recognition: patch }, 'recNote');
    $('recAuto').addEventListener('change', () => rec({ auto: $('recAuto').checked }));
    $('recFallback').addEventListener('change', () => rec({ fallback: $('recFallback').checked }));
    $('recSelfUrl').addEventListener('change', () => {
      const v = $('recSelfUrl').value.trim();
      const problem = selfUrlProblem(v);
      if (problem) {
        $('recNote').textContent = problem; // what was typed stays, to be corrected
        this.refused = 'recNote';
        return;
      }
      rec({ selfUrl: v });
    });
    $('recTest').addEventListener('click', () => this.test());
    for (const [id, name] of [['recKey', 'mineru'], ['recSelfKey', 'mineru-self']]) {
      bindEye($(id).closest('.secret'));
      // A new value replaces the key; Enter on an empty field removes a key that is set.
      $(id).addEventListener('change', () => $(id).value.trim() && this.secret(name, $(id).value, id));
      $(id).addEventListener('keydown', e => {
        if (e.key === 'Enter' && !$(id).value && this.getPrefs().secrets?.[name]) this.secret(name, '', id);
      });
    }
  }

  // Saves run through this.pending, so 测试 clicked right after typing tests what was typed.
  secret(name, value, id) {
    return (this.pending = this.writeSecret(name, value, id));
  }

  async writeSecret(name, value, id) {
    this.say('');
    try {
      const { prefs } = await this.call('secret_set', { name, value });
      $(id).value = '';
      hideKey($(id));
      this.onChange(prefs);
      this.render();
      this.say(value ? '已保存到钥匙串。' : '已删除。', true);
    } catch (e) {
      this.say(e.message);
    }
  }

  say(text, ok = false) {
    $('recNote').textContent = text;
    $('recNote').classList.toggle('ok', ok);
  }

  // 测试连接: each backend that is set up answers, and takes its key? Nothing is uploaded.
  async test() {
    await this.pending;
    const p = this.getPrefs();
    const list = [];
    if (p.recognition?.selfUrl) list.push(['self', '自部署 MinerU']);
    if (p.secrets?.mineru) list.push(['official', 'MinerU 官方 API']);
    if (!list.length) return this.say('先填写 MinerU Key，或自部署服务的地址。');
    this.say('测试中…', true);
    const results = await Promise.all(list.map(async ([backend, name]) => {
      const r = await this.call('recognition_test', { backend }).catch(e => ({ ok: false, message: e.message }));
      return { ...r, text: `${name}：${r.message}` };
    }));
    const ok = results.every(r => r.ok);
    const text = results.map(r => r.text).join('\n');
    this.say(text, ok);
    this.toast(ok ? `测试通过。${text}` : text, ok);
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

  save(patch, noteId) {
    return (this.pending = this.write(patch, noteId));
  }

  async write(patch, noteId) {
    if (noteId) $(noteId).textContent = '';
    $('recNote').classList.remove('ok');
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
    const r = p.recognition || {};
    $('recAuto').checked = !!r.auto;
    $('recFallback').checked = !!r.fallback;
    if (document.activeElement !== $('recSelfUrl') && this.refused !== 'recNote') $('recSelfUrl').value = r.selfUrl || '';
    for (const [id, name] of [['recKey', 'mineru'], ['recSelfKey', 'mineru-self']]) {
      $(id).placeholder = p.secrets?.[name] ? '已设置（输入新的替换；清空后回车删除）' : '未设置';
    }
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
