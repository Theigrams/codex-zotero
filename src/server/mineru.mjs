// MinerU's v4 local-file flow: request upload URL -> PUT PDF -> poll batch -> read structured ZIP.
// Only invoked by an explicit OCR action. The credential never leaves this module or enters a tool result.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import sanitizeHtml from 'sanitize-html';

const API = 'https://mineru.net/api/v4/';
const MAX_ZIP = 128 * 1024 * 1024;
const MAX_JSON = 32 * 1024 * 1024;
const plain = value => sanitizeHtml(String(value || ''), { allowedTags: [], allowedAttributes: {} });
const textOf = block => {
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(textOf).join('');
  if (block.content && typeof block.content === 'object') {
    const content = block.content;
    return ['title_content', 'paragraph_content', 'equation_content', 'table_caption', 'table_body', 'table_footnote', 'image_caption', 'image_footnote', 'code_content', 'list_items']
      .filter(key => content[key] != null)
      .map(key => typeof content[key] === 'string' ? (key === 'table_body' ? plain(content[key].replace(/<\/(?:tr|p)>/g, '\n').replace(/<\/(?:td|th)>/g, ' | ')) : content[key])
        : Array.isArray(content[key]) ? content[key].map(textOf).join('') : textOf(content[key])).join('\n');
  }
  const table = block.table_body || block.html;
  if (table) return plain(table.replace(/<\/(?:tr|p)>/g, '\n').replace(/<\/(?:td|th)>/g, ' | '));
  return [...(block.table_caption || []), ...(block.image_caption || []), ...(block.table_footnote || []), ...(block.image_footnote || [])].join('\n');
};
const typeOf = type => ({ equation: 'formula', interline_equation: 'formula', display_formula: 'formula', image: 'figure', chart: 'figure', table: 'table', title: 'title' }[type] || 'text');

export function normalizeOcr(payload, first, pageSizes) {
  const result = Object.fromEntries(pageSizes.map((_, i) => [first + i, { text: '', blocks: [] }]));
  const add = (b, idx, relative = true, normalized = true) => {
    if (!Number.isInteger(idx) || idx < 0) return;
    const page = relative ? first + idx : idx + 1;
    const item = result[page], size = pageSizes[page - first];
    if (!item || !size) return;
    const text = textOf(b).slice(0, 100000);
    if (text.trim()) item.text += `${text}\n\n`;
    const bbox = b.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return;
    const [w, h] = [size.width, size.height];
    const scaleX = normalized ? w / 1000 : 1, scaleY = normalized ? h / 1000 : 1;
    const x0 = Math.max(0, Math.min(w, bbox[0] * scaleX)), y0 = Math.max(0, Math.min(h, bbox[1] * scaleY));
    const x1 = Math.max(x0, Math.min(w, bbox[2] * scaleX)), y1 = Math.max(y0, Math.min(h, bbox[3] * scaleY));
    if (x1 <= x0 || y1 <= y0) return;
    item.blocks.push({ id: `ocr-${item.blocks.length}`, type: typeOf(b.type), text,
      rect: [x0, y0, x1-x0, y1-y0], source: 'mineru' });
  };
  if (Array.isArray(payload)) {
    payload.forEach((block, i) => {
      if (Array.isArray(block)) block.forEach(b => add(b, i));
      else add(block, block.page_idx ?? 0);
    });
  } else if (Array.isArray(payload.pdf_info)) {
    // Legacy middle.json uses PDF points, unlike the content-list's 0..1000 bboxes.
    payload.pdf_info.forEach((p, i) => (p.para_blocks || p.preproc_blocks || []).forEach(b => {
      const lines = b.lines || [];
      add({ ...b, text: lines.map(l => (l.spans || []).map(s => s.content || '').join('')).join('\n') }, p.page_idx ?? i, true, false);
    }));
  } else if (Array.isArray(payload.pages)) {
    payload.pages.forEach((p, i) => (p.blocks || []).forEach(b => add(b, p.page_idx ?? i)));
  } else throw new Error('MinerU 返回了未支持的结果结构。');
  for (const page of Object.values(result)) page.text = page.text.trim();
  if (!Object.values(result).some(p => p.text || p.blocks.length)) throw new Error('MinerU 结果没有可读内容，请检查文档或重试。');
  return result;
}

export function readOcrZip(bytes, first, pageSizes) {
  let total = 0;
  const files = unzipSync(bytes, { filter: file => {
    const keep = /(?:content_list(?:_v2)?|middle_json|layout|middle)\.json$/i.test(file.name);
    if (!keep) return false;
    total += file.originalSize;
    if (file.originalSize > MAX_JSON || total > MAX_JSON) throw new Error('MinerU JSON 结果过大。');
    return true;
  } });
  const rank = name => /_content_list\.json$/.test(name) ? 0 : name.includes('content_list') ? 1 : 2;
  const names = Object.keys(files).sort((a, b) => rank(a) - rank(b));
  for (const name of names) {
    try { return normalizeOcr(JSON.parse(strFromU8(files[name])), first, pageSizes); } catch (e) {
      if (name === names.at(-1)) throw e;
    }
  }
  throw new Error('MinerU 压缩包缺少内容列表或版面 JSON。');
}

async function limitedBytes(response, limit) {
  if (!response.ok) throw new Error(`MinerU 文件传输失败（HTTP ${response.status}）。`);
  const chunks = []; let n = 0;
  for await (const chunk of response.body) { n += chunk.length; if (n > limit) throw new Error('MinerU 结果文件过大。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const signedUrl = (value, api) => {
  const u = new URL(value);
  const localTest = new URL(api).hostname === '127.0.0.1' && u.hostname === '127.0.0.1' && u.protocol === 'http:';
  if ((!localTest && u.protocol !== 'https:') || u.username || u.password) throw new Error('MinerU 返回了无效的文件地址。');
  return u.href;
};

export class MinerU {
  constructor({ secretFile, fetchImpl = fetch, sleep = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('OCR 已取消。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }), api = API }) { Object.assign(this, { secretFile, fetchImpl, sleep, api }); }
  async key() {
    const key = process.env.MINERU_API_KEY || JSON.parse(await readFile(this.secretFile, 'utf8').catch(() => '{}')).apiKey;
    if (!key || typeof key !== 'string') throw new Error('尚未配置 MinerU API key，请运行 npm run configure-mineru。');
    return key.trim();
  }
  async configured() { try { return !!(await this.key()); } catch { return false; } }
  async json(route, { token, signal, body } = {}) {
    const response = await this.fetchImpl(this.api + route, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`MinerU 请求失败（HTTP ${response.status}），请检查 key、额度和网络。`);
    const r = JSON.parse((await limitedBytes(response, MAX_JSON)).toString());
    if (r.code !== 0) throw new Error(`MinerU 拒绝请求（代码 ${String(r.code).slice(0, 20)}）。请检查 key 和额度。`);
    return r.data;
  }
  async recognize({ file, first, pageSizes, signal, progress }) {
    const token = await this.key();
    const bytes = await readFile(file);
    if (bytes.length > 200 * 1024 * 1024) throw new Error('PDF 分片超过 MinerU 的 200 MB 限制，请缩小识别范围。');
    const name = `pages-${first}-${first + pageSizes.length - 1}.pdf`;
    const data = await this.json('file-urls/batch', { token, signal, body: {
      model_version: 'vlm', enable_formula: true, enable_table: true,
      files: [{ name, data_id: randomUUID(), is_ocr: true }],
    } });
    if (!data.batch_id || data.file_urls?.length !== 1) throw new Error('MinerU 未返回上传地址。');
    progress('uploading');
    const upload = await this.fetchImpl(signedUrl(data.file_urls[0], this.api), { method: 'PUT', body: bytes,
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
    if (!upload.ok) throw new Error(`MinerU 上传失败（HTTP ${upload.status}）。`);
    const started = Date.now();
    while (Date.now() - started < 15 * 60 * 1000) {
      signal.throwIfAborted();
      const batch = await this.json(`extract-results/batch/${encodeURIComponent(data.batch_id)}`, { token, signal });
      const item = batch.extract_result?.[0];
      if (item?.state === 'failed') throw new Error('MinerU 识别失败，请检查 PDF 或稍后重试。');
      if (item?.state === 'done') {
        // Remote completion precedes downloading, decoding and committing the local result.
        progress('downloading');
        const zip = await limitedBytes(await this.fetchImpl(signedUrl(item.full_zip_url, this.api), {
          redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        }), MAX_ZIP);
        progress('finalizing');
        return readOcrZip(zip, first, pageSizes);
      }
      progress(item?.state || 'pending', item?.extract_progress);
      await this.sleep(3000, signal);
    }
    throw new Error('MinerU 识别超过 15 分钟，请稍后重试。');
  }
}
