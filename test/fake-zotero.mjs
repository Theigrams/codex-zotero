// An in-memory stand-in for Zotero 10's local API: the endpoints the reader uses, with the same
// version, server-ID, write-token and API-key rules (from Zotero's server_localAPI.js).
// Used by unit tests and the preflight so no real library is ever written.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// papers: extra { key, attachment, title, pdf } items besides PAPER001 / ATTACH01.
// notes: HTML of child notes of PAPER001.
export async function fakeZotero({ pdf = '/tmp/paper.pdf', title = 'Test Paper', auth = 'always', annotations = [], papers = [], notes = [] } = {}) {
  const serverId = 'FAKESERVER01';
  let version = 1;
  const items = new Map();
  const tokens = new Set();
  const keys = new Set();
  const state = { auth, failWrites: 0, authorizations: 0, requests: [], items, offline: false };
  const put = (key, data) => items.set(key, { key, version: (version += 1), data: { key, ...data, version } });
  put('PAPER001', { itemType: 'journalArticle', title });
  put('ATTACH01', { itemType: 'attachment', parentItem: 'PAPER001', contentType: 'application/pdf', title: 'PDF' });
  const files = { ATTACH01: pdf };
  for (const p of papers) {
    put(p.key, { itemType: 'journalArticle', title: p.title });
    put(p.attachment, { itemType: 'attachment', parentItem: p.key, contentType: 'application/pdf', title: 'PDF' });
    files[p.attachment] = p.pdf;
  }
  notes.forEach((note, i) => put(`NOTE000${i + 1}`, { itemType: 'note', parentItem: 'PAPER001', note, tags: [] }));
  for (const [i, a] of annotations.entries()) put(a.key || `SEED${String(i).padStart(4, '0')}`, { itemType: 'annotation', parentItem: 'ATTACH01', tags: [], ...a });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Zotero-Server-ID': serverId, 'Last-Modified-Version': String(version), ...headers });
    res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  };
  const json = item => ({ key: item.key, version: item.data.version, data: { ...item.data, version: item.data.version } });
  const live = parent => [...items.values()].filter(i => i.data.parentItem === parent && !i.data.deleted);

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/api\//, '');
    state.requests.push(`${req.method} ${path}${url.search}`);
    if (state.offline) return req.socket.destroy();
    const sid = req.headers['zotero-server-id'];
    if (sid && sid !== serverId) return send(res, 412, 'server id');
    const write = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && path !== 'local/authorize';
    if (write) {
      if (!sid) return send(res, 428, 'Zotero-Server-ID required');
      const key = req.headers['zotero-api-key'];
      if (!keys.has(key)) return send(res, 401, 'API key required');
      if (key.startsWith('once')) keys.delete(key);
      if (state.failWrites > 0) {
        state.failWrites--;
        return send(res, 503, 'busy');
      }
    }
    let m;
    if (path === '') return send(res, 200, 'Nothing to see here.');
    if (path === 'local/authorize' && req.method === 'POST') {
      state.authorizations++;
      if (state.auth === 'deny') return send(res, 403, { denied: true });
      const key = `${state.auth === 'once' ? 'once' : 'keep'}${state.authorizations}`;
      keys.add(key);
      return send(res, 200, { key, remember: state.auth !== 'once' });
    }
    if ((m = path.match(/^users\/0\/items\/(\w{8})\/file\/view\/url$/))) return files[m[1]] ? send(res, 200, pathToFileURL(files[m[1]]).href) : send(res, 404, 'Not found');
    if (path === 'users/0/items/top' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const top = [...items.values()].filter(i => !i.data.parentItem && i.data.itemType !== 'annotation' && (i.data.title || '').toLowerCase().includes(q));
      return send(res, 200, top.map(i => ({ ...json(i), meta: { creatorSummary: 'Tester', parsedDate: '2024-01-01', numChildren: 1 } })));
    }
    if ((m = path.match(/^users\/0\/items\/(\w{8})\/children$/))) {
      const kids = live(m[1]).filter(i => !url.searchParams.get('itemType') || i.data.itemType === url.searchParams.get('itemType'));
      if (url.searchParams.get('format') === 'versions') {
        const since = req.headers['if-modified-since-version'];
        if (since !== undefined && Number(since) >= version) return send(res, 304);
        return send(res, 200, Object.fromEntries(kids.map(i => [i.key, i.data.version])));
      }
      return send(res, 200, kids.map(json));
    }
    if ((m = path.match(/^users\/0\/items\/(\w{8})$/))) {
      const item = items.get(m[1]);
      if (req.method === 'GET') return item ? send(res, 200, json(item)) : send(res, 404, 'Not found');
      if (req.method === 'PATCH') {
        if (!item) return send(res, 404, 'Not found');
        const expected = Number(req.headers['if-unmodified-since-version']);
        if (!Number.isFinite(expected)) return send(res, 428, 'If-Unmodified-Since-Version not provided');
        if (item.data.version > expected) return send(res, 412, 'modified');
        put(item.key, { ...item.data, ...JSON.parse(body) });
        return send(res, 204);
      }
      if (req.method === 'DELETE') {
        if (!item) return send(res, 404, 'Not found');
        const expected = Number(req.headers['if-unmodified-since-version']);
        if (!Number.isFinite(expected)) return send(res, 428, 'If-Unmodified-Since-Version not provided');
        if (item.data.version > expected) return send(res, 412, 'modified');
        items.delete(item.key);
        version += 1;
        return send(res, 204);
      }
    }
    if (path === 'users/0/items' && req.method === 'GET' && url.searchParams.get('q')) {
      const q = url.searchParams.get('q').toLowerCase();
      const hits = [...items.values()].filter(i => i.data.itemType === url.searchParams.get('itemType') && !i.data.deleted
        && [i.data.annotationText, i.data.annotationComment, ...(i.data.tags || []).map(t => t.tag)].some(v => (v || '').toLowerCase().includes(q)));
      return send(res, 200, hits.map(json));
    }
    if (path === 'users/0/items' && req.method === 'GET') {
      const want = (url.searchParams.get('itemKey') || '').split(',');
      return send(res, 200, want.map(k => items.get(k)).filter(Boolean).map(json));
    }
    if (path === 'users/0/items' && req.method === 'POST') {
      const token = req.headers['zotero-write-token'];
      if (token && tokens.has(token)) return send(res, 412, 'Write token already used');
      const result = { successful: {}, failed: {}, unchanged: {} };
      for (const [i, entry] of JSON.parse(body).entries()) {
        if (!['annotation', 'note'].includes(entry.itemType) || !items.has(entry.parentItem)) result.failed[i] = { code: 400, message: 'bad item' };
        else {
          const { key, version: _v, ...data } = entry;
          put(key, data);
          result.successful[i] = json(items.get(key));
        }
      }
      if (token) tokens.add(token);
      return send(res, 200, result);
    }
    send(res, 404, 'Not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/`,
    state,
    annotations: () => [...items.values()].filter(i => i.data.itemType === 'annotation').map(json),
    // Simulates someone editing the item in Zotero.
    edit: (key, patch) => put(key, { ...items.get(key).data, ...patch }),
    revoke: () => keys.clear(), // as if the user removed the app's access in Zotero

    close: () => new Promise(r => server.close(r)),
  };
}
