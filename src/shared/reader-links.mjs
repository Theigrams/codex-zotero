// Links carry locations, never filesystem paths or document text.
export function readerRoute({ itemKey, id, page = 1, rect } = {}) {
  if (!/^[A-Z0-9]{8}$/.test(itemKey || '') && !/^[a-f0-9]{16}$/.test(id || '')) return null;
  const params = new URLSearchParams({ page: String(page) });
  if (rect) params.set('rect', rect.join(','));
  return `/paper/${itemKey || id}?${params}`;
}
export function parseReaderRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('#')) return null;
  const url = new URL(value, 'https://reader.invalid');
  if (url.pathname === '/') return { home: true };
  const key = url.pathname.match(/^\/paper\/([A-Z0-9]{8}|[a-f0-9]{16})$/)?.[1];
  const page = Number(url.searchParams.get('page') || 1);
  if (!key || !Number.isSafeInteger(page) || page < 1) return null;
  const rect = url.searchParams.has('rect') ? url.searchParams.get('rect').split(',').map(Number) : undefined;
  if (rect && (rect.length !== 4 || !rect.every(Number.isFinite) || rect.some(v => v < 0) || !rect[2] || !rect[3])) return null;
  return { ...(key.length === 8 ? { itemKey: key } : { docId: key }), page, ...(rect ? { rect } : {}) };
}
export function readerDeepLink(location) {
  const path = readerRoute(location);
  return path && `codex://plugins/codex-zotero@codex-zotero-local/app/reader_library?path=${encodeURIComponent(path)}`;
}
