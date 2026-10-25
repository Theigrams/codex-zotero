// Local reader state: preferences and, per document, where the reader left off.
// Annotations and notes live in Zotero; nothing here is precious.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PALETTE, cleanPalette } from '../shared/annotations.mjs';
import { ACTIONS, reserved } from '../shared/keys.mjs';
import { parseTemplate } from './reading-questions.mjs';
import { DEFAULT_RENDER_MODE, RENDER_MODES } from '../shared/layout.mjs';
import { atomicJSON, jsonFile } from './files.mjs';

// keys: only the user's overrides (combo, or null for unbound); mapPrompt / mapModel / mapEffort / readingQuestions: '' means the default.
const DEFAULT_PREFS = { layoutEnabled: true, renderMode: DEFAULT_RENDER_MODE, palette: DEFAULT_PALETTE, keys: {}, mapPrompt: '', mapModel: '', mapEffort: '', readingQuestions: '' };
const MAX_PROMPT = 20000;
// The first default palette (疑问 marked for answers by a flag); saved copies of it give way to the current default.
const OLD_DEFAULT = ['#ffd400重点', '#a28ae5疑问', '#2ea8e5定义', '#5fb236启发', '#ff6666存疑'];
const isOldDefault = p => Array.isArray(p) && p.map(e => `${e.color}${e.tag}`).join() === OLD_DEFAULT.join();
const MAX_TABS = 12;

export class State {
  constructor(root) {
    this.root = root;
  }

  async prefs() {
    const saved = await jsonFile(join(this.root, 'preferences.json'), {});
    if (isOldDefault(saved.palette)) delete saved.palette;
    else if (Array.isArray(saved.palette)) saved.palette = saved.palette.map(({ color, tag }) => ({ color, tag }));
    return { ...DEFAULT_PREFS, ...saved };
  }

  // Saves run one after another: each reads what the previous one wrote.
  setPrefs(patch) {
    const run = (this.prefsQueue || Promise.resolve()).then(() => this.writePrefs(patch));
    this.prefsQueue = run.catch(() => {});
    return run;
  }

  async writePrefs(patch) {
    const next = { ...(await this.prefs()) };
    if (patch.layoutEnabled !== undefined) {
      if (typeof patch.layoutEnabled !== 'boolean') throw new Error('版面识别设置无效。');
      next.layoutEnabled = patch.layoutEnabled;
    }
    if (patch.renderMode !== undefined) {
      if (!RENDER_MODES.includes(patch.renderMode)) throw new Error('未知的渲染方式。');
      next.renderMode = patch.renderMode;
    }
    if (patch.palette === null) next.palette = DEFAULT_PALETTE;
    else if (patch.palette !== undefined) next.palette = cleanPalette(patch.palette);
    if (patch.keys !== undefined) {
      const keys = {};
      for (const [id, combo] of Object.entries(patch.keys || {})) {
        if (!ACTIONS.some(a => a.id === id)) continue;
        if (combo !== null && (typeof combo !== 'string' || combo.length > 40 || reserved(combo))) throw new Error(`快捷键无效：${combo}`);
        keys[id] = combo;
      }
      next.keys = keys;
    }
    if (patch.mapPrompt !== undefined) next.mapPrompt = String(patch.mapPrompt || '').slice(0, MAX_PROMPT);
    if (patch.readingQuestions !== undefined) {
      const t = String(patch.readingQuestions || '');
      if (t.trim()) parseTemplate(t); // refuses questions without groups, or repeated ones
      next.readingQuestions = t.trim() ? t : '';
    }
    if (patch.mapEffort !== undefined) {
      if (!['', 'low', 'medium', 'high'].includes(patch.mapEffort)) throw new Error('未知的推理强度。');
      next.mapEffort = patch.mapEffort === 'medium' ? '' : patch.mapEffort;
    }
    if (patch.mapModel !== undefined) {
      const m = String(patch.mapModel || '').trim();
      if (m && !/^[\w.:-]{1,60}$/.test(m)) throw new Error('模型名称无效。');
      next.mapModel = m;
    }
    // The default palette is not stored, so a later change of the default reaches everyone who kept it.
    const { palette, ...rest } = next;
    await atomicJSON(join(this.root, 'preferences.json'), JSON.stringify(palette) === JSON.stringify(DEFAULT_PALETTE) ? rest : next);
    return next;
  }

  docFile(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('无效的文档 id。');
    return join(this.root, 'documents', `${id}.json`);
  }

  async document(id) {
    return jsonFile(this.docFile(id), null);
  }

  // Called whenever a document is opened: remembers how to find it again.
  async touch(doc, now = Date.now()) {
    const prev = (await this.document(doc.id)) || {};
    const record = {
      ...prev, id: doc.id, path: doc.path, title: doc.title,
      itemKey: doc.itemKey ?? prev.itemKey ?? null, attachmentKey: doc.attachmentKey ?? prev.attachmentKey ?? null,
      pageCount: doc.pageCount ?? prev.pageCount ?? null, lastOpened: now,
    };
    await atomicJSON(this.docFile(doc.id), record);
    return record;
  }

  // position: { page, offset (0–1 within the page at the top of the view), zoom }
  async savePosition(id, position) {
    const record = await this.document(id);
    if (!record) throw new Error('未知文档。');
    const page = Math.max(1, Math.floor(position.page));
    const offset = Math.min(1, Math.max(0, Number(position.offset) || 0));
    const zoom = Math.min(4, Math.max(0.5, Number(position.zoom) || 1));
    await atomicJSON(this.docFile(id), { ...record, position: { page, offset, zoom }, lastRead: Date.now() });
  }

  async recent(limit = 30) {
    let names;
    try {
      names = await readdir(join(this.root, 'documents'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const records = [];
    for (const name of names.filter(n => /^[a-f0-9]{16}\.json$/.test(n))) {
      try {
        const r = await jsonFile(join(this.root, 'documents', name), null);
        if (r?.path && Number.isFinite(r.lastOpened)) records.push(r);
      } catch { /* one corrupt record must not hide the rest */ }
    }
    return records.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, limit);
  }

  // Open tabs (document ids, or note:KEY for Zotero notes, in order) and the active one; restored when the panel opens again.
  async tabs() {
    const t = await jsonFile(join(this.root, 'tabs.json'), {});
    const ids = Array.isArray(t.tabs) ? t.tabs.filter(id => /^([a-f0-9]{16}|note:[A-Z0-9]{8})$/.test(id)) : [];
    return { tabs: ids, active: ids.includes(t.active) ? t.active : null };
  }

  async setTabs({ tabs, active }) {
    const unique = [...new Set(tabs)].slice(-MAX_TABS);
    const next = { tabs: unique, active: unique.includes(active) ? active : (unique.at(-1) ?? null) };
    await atomicJSON(join(this.root, 'tabs.json'), next);
    return next;
  }

  // Adds a tab after the active one (or activates it if already open).
  async openTab(id) {
    const { tabs, active } = await this.tabs();
    if (!tabs.includes(id)) tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, id);
    return this.setTabs({ tabs, active: id });
  }

  // Closes a tab; the neighbor to its right (else left) becomes active.
  async closeTab(id) {
    const { tabs, active } = await this.tabs();
    const i = tabs.indexOf(id);
    if (i < 0) return { tabs, active };
    tabs.splice(i, 1);
    return this.setTabs({ tabs, active: active === id ? (tabs[i] ?? tabs[i - 1] ?? null) : active });
  }

  // Where each note tab was scrolled to, as a fraction of its height.
  async notePosition(key) {
    return (await jsonFile(join(this.root, 'notes.json'), {}))[key] ?? 0;
  }

  async saveNotePosition(key, top) {
    const all = await jsonFile(join(this.root, 'notes.json'), {});
    all[key] = Math.min(1, Math.max(0, Number(top) || 0));
    await atomicJSON(join(this.root, 'notes.json'), all);
  }
}
