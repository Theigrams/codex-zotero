// Access to the local Zotero API (http://127.0.0.1:23119). Never touches Zotero's SQLite.
// Writes (annotations) go through annotations.mjs; this file holds the transport and item lookup.
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Tests point this at a fake Zotero so no real library is touched.
export const API = process.env.CODEX_ZOTERO_API || 'http://127.0.0.1:23119/api/';
const KEY = /^[A-Z0-9]{8}$/;
export const validKey = key => KEY.test(key || '');

export class Offline extends Error {}

// One request to the local API; network failures become Offline so callers can retry quietly.
export const zoteroClient = base => async (route, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) => {
  try {
    return await fetch(base + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Zotero-API-Version': '3', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Offline('无法连接 Zotero：请启动 Zotero 并开启本地 API。');
  }
};
export const zoteroFetch = zoteroClient(API);

export async function localApi(route, { text = false } = {}) {
  const response = await zoteroFetch(`users/0/${route}`);
  if (response.status === 404) throw new Error('Zotero 中找不到这个条目，请检查 key。');
  if (!response.ok) throw new Error(`Zotero 本地 API 返回 HTTP ${response.status}`);
  return text ? (await response.text()).trim() : response.json();
}

// Resolves an item key (paper or PDF attachment) to its local PDF file.
// Adapted from the 0.12.0 prototype's resolveZoteroDocument.
export async function resolvePdf({ itemKey, attachmentKey }, read = localApi) {
  if (!validKey(itemKey) || (attachmentKey && !validKey(attachmentKey))) throw new Error('Zotero 条目 key 格式不对（应为 8 位大写字母或数字）。');
  let item = await read(`items/${itemKey}`);
  if (item.data.itemType === 'attachment' && item.data.parentItem) {
    if (attachmentKey && attachmentKey !== item.key) throw new Error('该附件不属于指定条目。');
    attachmentKey = item.key;
    itemKey = item.data.parentItem;
    item = await read(`items/${itemKey}`);
  }
  const standalone = item.data.itemType === 'attachment';
  const children = standalone ? [item] : await read(`items/${itemKey}/children`);
  const pdfs = children.filter(x => x.data.itemType === 'attachment' && x.data.contentType === 'application/pdf');
  const attachment = attachmentKey ? pdfs.find(x => x.key === attachmentKey) : pdfs.length === 1 ? pdfs[0] : null;
  if (!attachment) throw new Error(pdfs.length > 1 ? '该条目有多个 PDF 附件，请指定 attachmentKey。' : '该条目没有本机 PDF 附件。');
  let fileUrl = await read(`items/${attachment.key}/file/view/url`, { text: true });
  if (fileUrl.startsWith('"')) fileUrl = JSON.parse(fileUrl);
  const url = new URL(fileUrl);
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) throw new Error('Zotero 没有返回本机文件路径。');
  const path = await realpath(fileURLToPath(url));
  if (!(await stat(path)).isFile()) throw new Error('Zotero 附件不是文件。');
  return {
    itemKey, attachmentKey: attachment.key, path,
    title: item.data.title || attachment.data.title || '未命名 PDF',
  };
}

// Title / creator / year search over top-level items (Zotero's own quick search), papers only.
export async function searchLibrary(query, limit = 20, read = localApi) {
  const q = String(query || '').trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, qmode: 'titleCreatorYear', limit: String(Math.min(50, limit * 2)), sort: 'dateModified', direction: 'desc' });
  const items = await read(`items/top?${params}`);
  return items
    .filter(x => !['note', 'annotation', 'attachment'].includes(x.data.itemType) || x.data.contentType === 'application/pdf')
    .slice(0, limit)
    .map(x => ({
      key: x.key, title: x.data.title || '未命名', creators: x.meta?.creatorSummary || '',
      year: (x.meta?.parsedDate || x.data.date || '').slice(0, 4), hasChildren: (x.meta?.numChildren ?? 0) > 0,
    }));
}

// Annotations across the whole library whose text, comment or tags contain every word of the query, with the
// paper each belongs to: [{ key, paper: { key, title }, page, color, type, text, comment, tags }].
// Zotero's "everything" search also matches the full text of the parent PDF, so its hits are only candidates.
export async function searchAnnotations(query, limit = 30, read = localApi) {
  const q = String(query || '').trim();
  if (!q) return [];
  const terms = q.toLowerCase().split(/\s+/);
  const candidates = await read(`items?${new URLSearchParams({ itemType: 'annotation', q, qmode: 'everything', limit: '500' })}`);
  const items = candidates.filter(x => {
    const hay = [x.data.annotationText, x.data.annotationComment, ...(x.data.tags || []).map(t => t.tag)].join('\n').toLowerCase();
    return terms.every(t => hay.includes(t));
  }).slice(0, limit);
  const papers = new Map();
  const paperOf = async attachmentKey => {
    if (!papers.has(attachmentKey)) {
      papers.set(attachmentKey, (async () => {
        const att = await read(`items/${attachmentKey}`);
        const parent = att.data.parentItem ? await read(`items/${att.data.parentItem}`) : att;
        return { key: parent.key, attachmentKey, title: parent.data.title || att.data.title || '未命名' };
      })().catch(() => ({ key: null, attachmentKey, title: '（找不到所属论文）' })));
    }
    return papers.get(attachmentKey);
  };
  return Promise.all(items.map(async x => ({
    key: x.key, paper: await paperOf(x.data.parentItem), page: x.data.annotationPageLabel || '', color: x.data.annotationColor || '',
    type: x.data.annotationType, text: x.data.annotationText || '', comment: x.data.annotationComment || '', tags: (x.data.tags || []).map(t => t.tag),
  })));
}
