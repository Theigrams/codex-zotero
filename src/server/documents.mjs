// Open PDFs, identified by a content fingerprint; page sizes and crop regions are cached per fingerprint.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cropRegions } from '../shared/layout.mjs';
import { atomicJSON, jsonFile } from './files.mjs';

const META_VERSION = 2; // 2: crop-box origin, needed to place Zotero annotations

export class Documents {
  constructor({ pool, cacheRoot }) {
    this.pool = pool;
    this.cacheRoot = cacheRoot;
    this.byId = new Map();
  }

  // source: { path, title?, itemKey?, attachmentKey? } → document summary used by the panel and tools.
  async open(source, { background = false } = {}) {
    const bytes = await readFile(source.path);
    if (bytes.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) < 0) throw new Error('附件不是 PDF。');
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const id = fingerprint.slice(0, 16);
    const cached = this.byId.get(id);
    if (cached) {
      if (background) return { ...cached, ...sourceFields(source) };
      // Opening the same PDF through the host file viewer must not unlink its
      // already-known Zotero identity or discard its bibliographic title.
      if (source.itemKey) Object.assign(cached, sourceFields(source));
      else if (source.title && !cached.itemKey) cached.title = source.title;
      return cached;
    }

    const cacheDir = join(this.cacheRoot, id);
    const info = await this.pool.open(source.path);
    let meta = await jsonFile(join(cacheDir, 'meta.json'), null);
    if (meta?.version !== META_VERSION || meta.pages?.length !== info.pageCount) {
      const bounds = await Promise.all(info.pages.map((_, i) =>
        this.pool.run(source.path, { op: 'content_bounds', page: i + 1 }, 1).then(r => r.bounds)));
      const pages = info.pages.map((p, i) => ({ width: p.width, height: p.height, originX: p.originX, originY: p.originY, label: p.label, bounds: bounds[i] }));
      meta = { version: META_VERSION, pages, crops: cropRegions(pages) };
      await atomicJSON(join(cacheDir, 'meta.json'), meta);
    }
    const doc = {
      id, fingerprint, cacheDir, path: source.path, ...sourceFields(source),
      pageCount: meta.pages.length,
      pages: meta.pages.map(p => ({ width: p.width, height: p.height, originX: p.originX, originY: p.originY, label: p.label })),
      crops: meta.crops,
      unsupported: info.pages.some(p => p.rotation || p.originX || p.originY),
    };
    this.byId.set(id, doc);
    return background ? { ...doc } : doc;
  }

  get(id) {
    const doc = this.byId.get(id);
    if (!doc) throw new Error('论文尚未打开。');
    return doc;
  }

  // Reopens a remembered document after a server restart; the file may have moved or changed.
  async reopen(record) {
    if (this.byId.has(record.id)) return this.byId.get(record.id);
    await stat(record.path);
    const doc = await this.open(record);
    if (doc.id !== record.id) throw new Error('PDF 文件已变化，请从 Zotero 重新打开。');
    return doc;
  }
}

const sourceFields = s => ({
  title: s.title || s.path.split('/').pop().replace(/\.pdf$/i, ''),
  itemKey: s.itemKey || null,
  attachmentKey: s.attachmentKey || null,
});

// The fields the panel needs to lay a document out.
export const summary = doc => ({
  id: doc.id, title: doc.title, itemKey: doc.itemKey, attachmentKey: doc.attachmentKey,
  pageCount: doc.pageCount, pages: doc.pages, crops: doc.crops, unsupported: doc.unsupported,
});
