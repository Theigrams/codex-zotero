// A stand-in for MinerU's V1 API (upload → PUT → complete → parse job → poll → download the ZIP), for the unit
// tests and the preflight, in the two forms the plugin meets:
//   official:    the upload URL and the download (after a 302) are on another origin — object storage, which
//                refuses a request that carries the API key; a file uploaded before is recognized by its SHA-256;
//                the ZIP holds content_list.json and a copy of the PDF.
//   self-hosted: same-origin upload that needs the key; the ZIP holds structured_content.json (0–1 boxes).
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_CONTENT = [
  { type: 'header', text: 'Journal header', bbox: [50, 20, 950, 35], page_idx: 0 },
  { type: 'text', text: 'Recognized title', text_level: 1, bbox: [100, 60, 900, 90], page_idx: 0 },
  { type: 'text', text: 'Recognized paragraph with $x^2$ inline.', bbox: [100, 100, 480, 200], page_idx: 0 },
  { type: 'equation', text: '$$\n\\Phi^*(u) = \\sum_{j=0}^{n_r} \\Theta_j^* N_{j,k}(u) \\tag{12}\n$$', text_format: 'latex', bbox: [520, 300, 640, 340], page_idx: 0 },
  { type: 'equation', text: '$$\na = b \\tag {7a}\\tag{7b}\n$$', text_format: 'latex', bbox: [100, 400, 400, 440], page_idx: 0 },
  { type: 'table', table_caption: ['Table 1', 'Limits'], table_body: '<table><tr><td>A</td><td>2</td></tr><tr><td>C</td><td>5</td></tr></table>', bbox: [100, 500, 900, 600], page_idx: 0 },
  { type: 'chart', img_path: 'images/a.jpg', image_caption: ['(a)'], bbox: [100, 650, 480, 850], page_idx: 0 },
  { type: 'chart', img_path: 'images/b.jpg', image_caption: ['(b)', 'Fig. 1. Two views of the setup.'], bbox: [520, 650, 900, 850], page_idx: 0 },
];

// What mineru-kit 4.0.12 writes for the same page.
export const FAKE_STRUCTURED = { pages: [{ page_idx: 0, blocks: [
  { type: 'header', bbox: [0.05, 0.02, 0.95, 0.035], content: 'Journal header' },
  { type: 'doc_title', bbox: [0.1, 0.06, 0.9, 0.09], level: 1, content: 'Recognized title' },
  { type: 'text', bbox: [0.1, 0.1, 0.48, 0.2], content: 'Recognized paragraph with $x^2$ inline.' },
  { type: 'equation', bbox: [0.52, 0.3, 0.64, 0.34], content: '\\Phi^*(u) = \\sum_{j=0}^{n_r} \\Theta_j^* N_{j,k}(u) \\tag{12}' },
  { type: 'table', bbox: [0.1, 0.5, 0.9, 0.6], content: '| A | 2 |\n| --- | --- |\n| C | 5 |', captions: [{ content: 'Table 1' }, { content: 'Limits' }], footnotes: [] },
  { type: 'chart', bbox: [0.1, 0.65, 0.48, 0.85], content: '', captions: [{ bbox: [0.1, 0.65, 0.12, 0.66], content: 'a' }], image_source: 'images/a.jpg' },
  { type: 'chart', bbox: [0.52, 0.65, 0.9, 0.85], content: '', captions: [{ bbox: [0.52, 0.65, 0.54, 0.66], content: 'b' }, { bbox: [0.3, 0.86, 0.7, 0.88], content: 'Fig. 1. Two views of the setup.' }], image_source: 'images/b.jpg' },
] }] };

const zipOf = async files => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-mineru-'));
  try {
    for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), data);
    await new Promise((resolve, reject) => execFile('/usr/bin/zip', ['-q', 'out.zip', ...Object.keys(files)], { cwd: dir }, e => (e ? reject(e) : resolve())));
    return await readFile(join(dir, 'out.zip'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

// key: the accepted Bearer token ('' for an anonymous self-hosted service); polls: "running" answers before the
// end; fail: the parse fails.
export async function fakeMinerU({ official = false, key = 'test-key', polls = 1, fail = false, content = FAKE_CONTENT, structured = FAKE_STRUCTURED } = {}) {
  const log = [];
  const known = new Set(); // SHA-256 of files already uploaded (official cache)
  let uploaded = null, asked = 0, sha = '';
  const zip = async () => zipOf(official
    ? { 'x_content_list.json': JSON.stringify(content), 'full.md': '# Recognized', 'x_origin.pdf': uploaded || '' }
    : { 'structured_content.json': JSON.stringify(structured), 'markdown.md': '# Recognized' });
  const body = async req => {
    const parts = [];
    for await (const c of req) parts.push(c);
    return Buffer.concat(parts);
  };

  // Object storage: another origin, which must never see the API key.
  const storage = createServer(async (req, res) => {
    const b = await body(req);
    log.push(`storage ${req.method} ${req.url}${req.headers.authorization ? ' WITH KEY' : ''}`);
    if (req.headers.authorization) return res.writeHead(403).end();
    if (req.method === 'PUT') {
      uploaded = b;
      return res.writeHead(200).end();
    }
    if (req.method === 'GET' && req.url === '/zip') return res.writeHead(200, { 'Content-Type': 'application/zip' }).end(await zip());
    res.writeHead(404).end();
  });
  const storageUrl = official ? await listen(storage) : null;

  const api = createServer(async (req, res) => {
    const b = await body(req);
    const base = `http://127.0.0.1:${api.address().port}`;
    const json = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const error = (status, message) => json({ error: { type: 'invalid_request_error', message } }, status);
    log.push(`${req.method} ${req.url}`);
    if (req.url !== '/v1/health' && key && req.headers.authorization !== `Bearer ${key}`) return error(401, 'Invalid or missing API key');
    const file = { id: 'file-in', object: 'file' };
    if (req.method === 'POST' && req.url === '/v1/uploads') {
      const r = JSON.parse(b.toString());
      if (r.purpose !== 'parse' || !r.sha256sum) return error(400, 'purpose: Input should be parse');
      sha = r.sha256sum;
      if (official && known.has(sha)) return json({ id: 'up1', status: 'completed', file });
      return json({ id: 'up1', status: 'pending', upload_method: 'PUT',
        upload_url: official ? `${storageUrl}/put/up1?Signature=s` : `${base}/v1/uploads/up1/content`,
        upload_headers: { 'Content-Type': 'application/pdf', 'x-amz-content-sha256': sha } });
    }
    if (req.method === 'PUT' && req.url === '/v1/uploads/up1/content') {
      uploaded = b;
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/v1/uploads/up1/complete') {
      if (!uploaded) return error(400, 'nothing uploaded');
      known.add(sha);
      return json({ id: 'up1', status: 'completed', file });
    }
    if (req.method === 'POST' && req.url === '/v1/parse/jobs') {
      asked = 0;
      return json({ job_id: 'job1', status: 'queued', files: [{ file_id: 'file-in', status: 'queued' }] }, official ? 200 : 202);
    }
    if (req.method === 'GET' && req.url === '/v1/parse/jobs/job1') {
      if (asked++ < polls) return json({ job_id: 'job1', status: 'running', files: [{ file_id: 'file-in', status: 'running' }] });
      if (fail) return json({ job_id: 'job1', status: 'failed', files: [{ file_id: 'file-in', status: 'failed', error: { message: 'file damaged' } }] });
      return json({ job_id: 'job1', status: 'completed', files: [{ file_id: 'file-in', status: 'completed', output_files: { zip: { file_id: 'file-zip' }, markdown: null } }] });
    }
    if (req.method === 'GET' && req.url === '/v1/files/file-zip/content') {
      if (official) return res.writeHead(302, { Location: `${storageUrl}/zip` }).end();
      return res.writeHead(200, { 'Content-Type': 'application/zip' }).end(await zip());
    }
    error(404, 'not found');
  });
  const url = await listen(api);
  return {
    url: `${url}/`, log, uploaded: () => uploaded, puts: () => log.filter(l => /PUT/.test(l)).length,
    close: () => { api.close(); storage.close(); },
  };
}
