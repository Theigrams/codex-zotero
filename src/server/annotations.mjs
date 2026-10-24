// Zotero annotations: incremental reads, and a write queue so the panel never waits on Zotero.
// New annotations get their Zotero key here, before anything is written, so the panel draws them
// at once and nothing has to be renamed later. Every write first reads the item back and refuses
// to overwrite what was changed in Zotero meanwhile (adapted from the 0.12.0 prototype's
// zotero-write.mjs and zotero-annotations-cache.mjs, which passed real-Zotero acceptance).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fromZotero, tagsForColor, toZotero } from '../shared/annotations.mjs';
import { atomicJSON, jsonFile } from './files.mjs';
import { Offline, validKey, zoteroFetch } from './zotero.mjs';

const APP_NAME = 'Codex Zotero 阅读器';
const BACKOFF_S = [2, 5, 15, 30, 60];
const MAX_TRIES = 6;          // then the write waits in the drawer for a manual retry
const KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
const newKey = () => [...randomBytes(8)].map(b => KEY_CHARS[b % 32]).join('');
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// An error that retrying will not fix (denied authorization, rejected content, conflicts).
class Final extends Error {
  constructor(message, status = 'failed') {
    super(message);
    this.status = status;
  }
}

// ---------- reading ----------

// Per attachment: the item versions Zotero reports, refreshed with If-Modified-Since-Version (usually a 304).
// Versions belong to one Zotero database (Zotero-Server-ID); a different ID drops everything.
export class AnnotationCache {
  constructor({ fetch = zoteroFetch, now = Date.now, ttl = 1500 } = {}) {
    Object.assign(this, { fetch, now, ttl });
    this.entries = new Map();
    this.pending = new Map();
    this.serverId = null;
  }

  async request(route, headers = {}) {
    const r = await this.fetch(route, { headers });
    if (r.status === 412) {
      this.entries.clear();
      this.serverId = null;
      return { retry: true };
    }
    if (r.status !== 304 && !r.ok) throw new Error(`Zotero 批注读取失败（HTTP ${r.status}）`);
    const id = r.headers.get('Zotero-Server-ID');
    if (!id) throw new Error('读取批注需要 Zotero 10 的本地 API。');
    if (this.serverId && id !== this.serverId) this.entries.clear();
    this.serverId = id;
    const version = Number(r.headers.get('Last-Modified-Version'));
    if (!Number.isSafeInteger(version)) throw new Error('Zotero 没有返回有效的版本号。');
    return { r, version, id };
  }

  version(attachmentKey) {
    const e = this.entries.get(attachmentKey);
    return e ? `${e.serverId}:${e.version}` : '';
  }

  invalidate(attachmentKey) {
    const e = this.entries.get(attachmentKey);
    if (e) e.checked = 0;
  }

  async get(attachmentKey, { force = false } = {}) {
    if (!validKey(attachmentKey)) throw new Error('附件 key 无效。');
    const e = this.entries.get(attachmentKey);
    if (!force && e && this.now() - e.checked < this.ttl) return [...e.items.values()];
    if (!this.pending.has(attachmentKey)) {
      this.pending.set(attachmentKey, this.refresh(attachmentKey).finally(() => this.pending.delete(attachmentKey)));
    }
    return this.pending.get(attachmentKey);
  }

  async refresh(attachmentKey) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = this.entries.get(attachmentKey);
      const head = await this.request(`users/0/items/${attachmentKey}/children?itemType=annotation&format=versions`, {
        ...(this.serverId ? { 'Zotero-Server-ID': this.serverId } : {}),
        ...(old ? { 'If-Modified-Since-Version': String(old.version) } : {}),
      });
      if (head.retry) continue;
      if (head.r.status === 304 && old) {
        old.checked = this.now();
        return [...old.items.values()];
      }
      const versions = await head.r.json();
      if (!versions || typeof versions !== 'object' || Array.isArray(versions)) throw new Error('Zotero 批注版本响应无效。');
      const baseline = old?.serverId === head.id ? old.items : new Map();
      const next = new Map();
      const changed = [];
      for (const [k, v] of Object.entries(versions)) {
        const have = baseline.get(k);
        if (have && have.version === v) next.set(k, have);
        else changed.push(k);
      }
      let consistent = true;
      for (let i = 0; i < changed.length && consistent; i += 50) {
        const keys = changed.slice(i, i + 50);
        const page = await this.request(`users/0/items?${new URLSearchParams({ itemKey: keys.join(','), itemType: 'annotation' })}`, { 'Zotero-Server-ID': head.id });
        // Zotero changed between the two requests: start over rather than mix two states.
        if (page.retry || page.version !== head.version) consistent = false;
        else {
          for (const item of await page.r.json()) {
            if (item.data?.parentItem === attachmentKey && !item.data.deleted) next.set(item.key, item);
          }
        }
      }
      if (!consistent) continue;
      this.entries.set(attachmentKey, { serverId: head.id, version: head.version, items: next, checked: this.now() });
      return [...next.values()];
    }
    throw new Error('Zotero 正在连续修改，稍后再刷新批注。');
  }
}

// ---------- writing ----------

// What can be changed on an existing annotation. Not its type: Zotero refuses that ("Cannot change existing
// annotationType"), so highlight vs. underline is chosen when the annotation is made.
const FIELD = { comment: 'annotationComment', color: 'annotationColor' };
const fieldsOf = data => ({ comment: data.annotationComment || '', color: (data.annotationColor || '').toLowerCase() });
// The fields that recreate an annotation (undo of a delete).
const CREATE_FIELDS = ['itemType', 'parentItem', 'annotationType', 'annotationText', 'annotationComment', 'annotationColor',
  'annotationPageLabel', 'annotationSortIndex', 'annotationPosition', 'tags'];
const MAX_UNDO = 20;

// Applies a reader patch ({ comment?, color? }) to Zotero item JSON; a new color swaps the palette tag.
function patchData(data, patch, palette) {
  const out = { ...data };
  for (const [k, v] of Object.entries(patch)) out[FIELD[k]] = k === 'color' ? v.toLowerCase() : v;
  if (patch.color) out.tags = tagsForColor(data.tags || [], patch.color, palette);
  return out;
}

// Ops: { id, kind: 'create'|'update'|'delete', attachmentKey, key, payload?, patch?, before?, status, error, tries, next }
// status: 'pending' (will be retried by itself), 'failed' (waits for a retry from the drawer), 'conflict' (needs the user).
export class Writer {
  constructor({ root, fetch = zoteroFetch, now = Date.now, onChange = () => {}, backoff = BACKOFF_S.map(s => s * 1000) }) {
    Object.assign(this, { root, fetch, now, onChange, backoff });
    this.file = join(root, 'writes.json');
    this.authFile = join(root, 'zotero-auth.json');
    this.ops = [];
    this.rev = 0;
    this.running = null;
    this.timer = null;
    this.oneTimeKey = null;
    this.loaded = this.load();
  }

  async load() {
    // 'trash' was the name of delete before deletes became real deletes (as in Zotero itself).
    this.ops = (await jsonFile(this.file, [])).map(op => ({ ...op, kind: op.kind === 'trash' ? 'delete' : op.kind, next: 0 }));
    this.kick();
  }

  async save() {
    this.rev++;
    await atomicJSON(this.file, this.ops.map(({ next, ...op }) => op));
  }

  forAttachment(attachmentKey) {
    return this.ops.filter(op => op.attachmentKey === attachmentKey);
  }

  async enqueue(op) {
    await this.loaded;
    const same = this.ops.filter(o => o.key === op.key && o.id !== this.running?.id);
    const create = same.find(o => o.kind === 'create');
    const update = same.find(o => o.kind === 'update');
    if (create && op.kind === 'update') {
      create.payload = patchData(create.payload, op.patch, op.palette); // not written yet: just write the edited version
    } else if (create && op.kind === 'delete') {
      this.ops = this.ops.filter(o => o !== create && o !== update);
    } else if (update && op.kind === 'update') {
      update.patch = { ...update.patch, ...op.patch };
      update.status = 'pending';
      update.tries = 0;
    } else {
      if (update && op.kind === 'delete') {
        op.before = update.before;
        this.ops = this.ops.filter(o => o !== update);
      }
      this.ops.push({ id: randomUUID(), status: 'pending', error: '', tries: 0, next: 0, ...op });
    }
    await this.save();
    this.onChange(op.attachmentKey);
    this.kick();
  }

  async retry(id) {
    await this.loaded;
    for (const op of this.ops) {
      if ((!id || op.id === id) && op.status === 'failed') Object.assign(op, { status: 'pending', tries: 0, next: 0, error: '' });
    }
    await this.save();
    this.kick();
  }

  // Gives up on a write (the user's choice for a conflict); Zotero keeps what it has.
  async discard(id) {
    await this.loaded;
    const op = this.ops.find(o => o.id === id);
    if (!op || op.id === this.running?.id) return;
    this.ops = this.ops.filter(o => o !== op);
    await this.save();
    this.onChange(op.attachmentKey);
  }

  kick() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return;
    const due = this.ops.filter(o => o.status === 'pending');
    const now = this.now();
    const op = due.find(o => o.next <= now);
    if (op) {
      this.running = op;
      this.run(op).finally(() => {
        this.running = null;
        this.kick();
      });
    } else if (due.length) {
      this.timer = setTimeout(() => this.kick(), Math.max(50, Math.min(...due.map(o => o.next)) - now));
      this.timer.unref?.();
    }
  }

  async run(op) {
    try {
      await this.perform(op);
      this.ops = this.ops.filter(o => o !== op);
    } catch (e) {
      op.tries++;
      op.error = e.message;
      if (e instanceof Final) op.status = e.status;
      else if (op.tries >= MAX_TRIES) op.status = 'failed';
      else op.next = this.now() + this.backoff[Math.min(op.tries - 1, this.backoff.length - 1)];
    }
    await this.save().catch(() => {});
    this.onChange(op.attachmentKey);
  }

  async serverId() {
    const r = await this.fetch('');
    const id = r.headers.get('Zotero-Server-ID');
    if (!id) throw new Final('保存批注需要 Zotero 10 的本地 API。');
    return id;
  }

  async getItem(key, serverId) {
    const r = await this.fetch(`users/0/items/${key}`, { headers: { 'Zotero-Server-ID': serverId } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Zotero 读取失败（HTTP ${r.status}）`);
    return r.json();
  }

  // Zotero shows its own Allow / Always Allow / Deny dialog. Only "Always Allow" keys are kept on disk.
  async authorize(serverId, fresh = false) {
    if (!fresh) {
      if (this.oneTimeKey?.serverId === serverId) return this.oneTimeKey.key;
      const stored = await jsonFile(this.authFile, null);
      if (stored?.serverId === serverId && stored.key) return stored.key;
    }
    this.oneTimeKey = null;
    const r = await this.fetch('local/authorize', { method: 'POST', body: { appName: APP_NAME }, headers: { 'Zotero-Server-ID': serverId }, timeout: 300000 });
    if (r.status === 403) throw new Final('Zotero 写入授权被拒绝。可在这里重试，Zotero 会再次询问。');
    if (r.status === 429) throw new Error('授权请求太频繁，稍后重试。');
    if (!r.ok) throw new Error(`Zotero 授权失败（HTTP ${r.status}）`);
    const data = await r.json();
    if (!data.key) throw new Error('Zotero 没有返回授权。');
    if (data.remember) await atomicJSON(this.authFile, { serverId, key: data.key });
    else this.oneTimeKey = { serverId, key: data.key };
    return data.key;
  }

  // A write with the stored key; on 401 asks Zotero once more for authorization.
  async write(route, opts, serverId) {
    for (const fresh of [false, true]) {
      const apiKey = await this.authorize(serverId, fresh);
      const r = await this.fetch(route, { ...opts, headers: { ...opts.headers, 'Zotero-Server-ID': serverId, 'Zotero-API-Key': apiKey } });
      if (this.oneTimeKey?.key === apiKey && r.status !== 401) this.oneTimeKey = null; // "Allow" keys are single-use
      if (r.status === 401) {
        if (!fresh) await atomicJSON(this.authFile, {});
        continue;
      }
      return r;
    }
    throw new Error('Zotero 授权失效。');
  }

  // A child note written at once (not queued): the paper map. Creates it, or replaces the content of `key`
  // if Zotero still has it; returns the note's key.
  async writeNote({ parentItem, key, html, tags = [] }) {
    const serverId = await this.serverId();
    const remote = key ? await this.getItem(key, serverId) : null;
    const check = async r => {
      if (!r.ok) throw new Error(`Zotero 没有接受这篇笔记（HTTP ${r.status}）：${(await r.text()).slice(0, 200)}`);
      return r;
    };
    if (remote && !remote.data.deleted) {
      await check(await this.write(`users/0/items/${key}`, {
        method: 'PATCH', body: { note: html, tags }, headers: { 'If-Unmodified-Since-Version': String(remote.version ?? remote.data.version) },
      }, serverId));
      return key;
    }
    const newKeyValue = newKey();
    const r = await check(await this.write('users/0/items', { method: 'POST', body: [{ itemType: 'note', parentItem, note: html, tags, key: newKeyValue, version: 0 }] }, serverId));
    const result = await r.json();
    const failed = result.failed?.['0'];
    if (failed) throw new Error(`Zotero 拒绝了这篇笔记：${failed.message || failed.code}`);
    return newKeyValue;
  }

  async perform(op) {
    const serverId = await this.serverId();
    const remote = await this.getItem(op.key, serverId);
    const check = async r => {
      if (r.status === 412) throw new Error('Zotero 中的内容刚刚变化，稍后重试。');
      if (r.status === 400 || r.status === 403 || r.status === 404 || r.status === 409) throw new Final(`Zotero 拒绝了这次修改（HTTP ${r.status}）：${(await r.text()).slice(0, 200)}`);
      if (!r.ok) throw new Error(`Zotero 写入未确认（HTTP ${r.status}）`);
      return r;
    };

    if (op.kind === 'create') {
      if (remote) return; // an earlier attempt landed (the key is ours alone)
      const attachment = await this.getItem(op.attachmentKey, serverId);
      if (!attachment || attachment.data.itemType !== 'attachment') throw new Final('Zotero 中找不到这篇论文的 PDF 附件。');
      const r = await check(await this.write('users/0/items', {
        method: 'POST', body: [{ ...op.payload, key: op.key, version: 0 }],
        headers: { 'Zotero-Write-Token': digest(op.id).slice(0, 32) },
      }, serverId));
      const result = await r.json();
      const failed = result.failed?.['0'];
      if (failed) throw new Final(`Zotero 拒绝了这条批注：${failed.message || failed.code}`);
      if (!(await this.getItem(op.key, serverId))) throw new Error('写入后没有在 Zotero 中找到这条批注，稍后重试。');
      return;
    }

    if (!remote) {
      if (op.kind === 'delete') return;
      throw new Final('这条批注已在 Zotero 中删除，修改没有写入。', 'conflict');
    }
    if (remote.data.deleted && op.kind !== 'delete') throw new Final('这条批注已在 Zotero 回收站中，修改没有写入。', 'conflict');
    const now = fieldsOf(remote.data);
    const touched = op.kind === 'delete' ? Object.keys(op.before || {}) : Object.keys(op.patch);
    if (op.kind === 'update' && touched.every(k => now[k] === (k === 'color' ? op.patch[k].toLowerCase() : op.patch[k]))) return;
    if (op.before && touched.some(k => now[k] !== op.before[k])) {
      throw new Final('这条批注在 Zotero 中已被修改，没有覆盖。', 'conflict');
    }
    const headers = { 'If-Unmodified-Since-Version': String(remote.version ?? remote.data.version) };
    if (op.kind === 'delete') {
      // Zotero's own reader erases annotations rather than trashing them (a trashed one stays visible there).
      const r = await this.write(`users/0/items/${op.key}`, { method: 'DELETE', headers }, serverId);
      if (r.status !== 404) await check(r);
      return;
    }
    const next = patchData(remote.data, op.patch, op.palette);
    const body = Object.fromEntries(touched.map(k => [FIELD[k], next[FIELD[k]]]));
    if (op.patch.color) body.tags = next.tags;
    await check(await this.write(`users/0/items/${op.key}`, { method: 'PATCH', body, headers }, serverId));
  }
}

// ---------- what the panel sees ----------

export class Annotations {
  // palette(): the user's colors and tags (settings), read whenever an annotation is made or recolored.
  constructor({ root, fetch = zoteroFetch, backoff, palette = async () => undefined }) {
    this.palette = palette;
    this.cache = new AnnotationCache({ fetch });
    this.writer = new Writer({ root, fetch, backoff, onChange: key => this.cache.invalidate(key) });
    this.last = new Map(); // attachment → last list that loaded, kept while Zotero is unreachable
    this.deleted = new Map(); // attachment → payloads of annotations deleted here, newest last (undo)
  }

  // { rev, items, writes, error? }; with since === rev only { rev, unchanged: true }.
  async list(doc, { since } = {}) {
    if (!doc.attachmentKey) return { rev: 'none', items: [], writes: [], available: false };
    let remote = this.last.get(doc.attachmentKey);
    let error = '';
    try {
      remote = await this.cache.get(doc.attachmentKey);
      this.last.set(doc.attachmentKey, remote);
    } catch (e) {
      error = e instanceof Offline ? '无法连接 Zotero' : e.message;
    }
    const rev = `${this.cache.version(doc.attachmentKey)}:${this.writer.rev}:${error ? 'e' : ''}`;
    if (since && since === rev) return { rev, unchanged: true };
    return { rev, available: true, error, ...this.merge(doc, remote || []) };
  }

  // Zotero's items with the queued writes applied on top, so a refresh never undoes what the user just did.
  merge(doc, remote) {
    const items = new Map();
    for (const item of remote) {
      const a = fromZotero(item, doc.pages);
      if (a) items.set(a.key, a);
    }
    const writes = [];
    for (const op of this.writer.forAttachment(doc.attachmentKey)) {
      if (op.kind === 'create' && !items.has(op.key)) {
        const a = fromZotero({ key: op.key, version: 0, data: op.payload }, doc.pages);
        if (a) items.set(op.key, { ...a, state: op.status });
      } else if (op.kind === 'update' && items.has(op.key)) {
        const a = items.get(op.key);
        const tags = op.patch.color ? tagsForColor(a.tags.map(tag => ({ tag })), op.patch.color, op.palette).map(t => t.tag) : a.tags;
        items.set(op.key, { ...a, ...op.patch, ...(op.patch.color ? { color: op.patch.color.toLowerCase() } : {}), tags, state: op.status });
      } else if (op.kind === 'delete') {
        items.delete(op.key);
      }
      if (op.status !== 'pending') {
        const a = items.get(op.key);
        const label = op.kind === 'create' ? '新建' : op.kind === 'update' ? '修改' : '删除';
        writes.push({ id: op.id, kind: op.kind, label, key: op.key, status: op.status, error: op.error, page: a?.page ?? null, text: (a?.text || op.payload?.annotationText || '').slice(0, 80) });
      }
    }
    const sorted = [...items.values()].sort((x, y) => (x.sortIndex < y.sortIndex ? -1 : x.sortIndex > y.sortIndex ? 1 : 0));
    return { items: sorted, writes, pending: this.writer.forAttachment(doc.attachmentKey).filter(o => o.status === 'pending').length };
  }

  requireZotero(doc) {
    if (!doc.attachmentKey) throw new Error('这篇 PDF 不是从 Zotero 打开的，批注无处保存。');
  }

  // sel: { kind, page, rects, text, offset }; style: { color, type, comment, tags }
  async create(doc, sel, style = {}) {
    this.requireZotero(doc);
    const payload = toZotero(doc, sel, { ...style, palette: await this.palette() });
    const key = newKey();
    await this.writer.enqueue({ kind: 'create', attachmentKey: doc.attachmentKey, key, payload });
    return key;
  }

  async current(doc, key) {
    const { items } = await this.list(doc);
    const a = items.find(x => x.key === key);
    if (!a) throw new Error('找不到这条批注。');
    return a;
  }

  async update(doc, key, patch) {
    this.requireZotero(doc);
    const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => FIELD[k] && v !== undefined));
    if (clean.color && !/^#[0-9a-f]{6}$/i.test(clean.color)) throw new Error('颜色无效。');
    if (patch.type !== undefined) throw new Error('Zotero 不允许修改已有批注的类型（高亮/下划线）；可删除后重新标注。');
    const a = await this.current(doc, key);
    if (!Object.keys(clean).length) return;
    const before = Object.fromEntries(Object.keys(clean).map(k => [k, a[k]]));
    await this.writer.enqueue({ kind: 'update', attachmentKey: doc.attachmentKey, key, patch: clean, before, palette: await this.palette() });
  }

  // Deletes for good, like Zotero; the payload is kept so ⌘Z in the panel can bring it back (with a new key).
  async remove(doc, key) {
    this.requireZotero(doc);
    const a = (await this.list(doc)).items.find(x => x.key === key);
    // Not listed: maybe in the Zotero trash (older versions of this reader trashed instead of deleting).
    if (!a) return this.removeTrashed(doc, key);
    const raw = this.cache.entries.get(doc.attachmentKey)?.items.get(key)?.data
      || this.writer.ops.find(o => o.kind === 'create' && o.key === key)?.payload;
    if (raw) {
      const stack = this.deleted.get(doc.attachmentKey) || [];
      stack.push(Object.fromEntries(CREATE_FIELDS.filter(f => raw[f] !== undefined).map(f => [f, raw[f]])));
      this.deleted.set(doc.attachmentKey, stack.slice(-MAX_UNDO));
    }
    await this.writer.enqueue({ kind: 'delete', attachmentKey: doc.attachmentKey, key, before: { comment: a.comment, color: a.color } });
  }

  async removeTrashed(doc, key) {
    const item = await this.writer.getItem(key, await this.writer.serverId());
    if (!item || item.data.itemType !== 'annotation' || item.data.parentItem !== doc.attachmentKey) throw new Error('找不到这条批注。');
    await this.writer.enqueue({ kind: 'delete', attachmentKey: doc.attachmentKey, key });
  }

  // Recreates the most recently deleted annotation of this paper; returns its new key, or null.
  async undoDelete(doc) {
    const payload = this.deleted.get(doc.attachmentKey)?.pop();
    if (!payload) return null;
    const key = newKey();
    await this.writer.enqueue({ kind: 'create', attachmentKey: doc.attachmentKey, key, payload });
    return key;
  }
}
