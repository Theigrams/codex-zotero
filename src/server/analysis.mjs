import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonFile, atomicJSON } from './files.mjs';

const iou = (a, b) => {
  const overlap = Math.max(0, Math.min(a[0]+a[2], b[0]+b[2])-Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1]+a[3], b[1]+b[3])-Math.max(a[1], b[1]));
  return overlap / Math.max(1, a[2]*a[3]+b[2]*b[3]-overlap);
};
const validPage = (doc, page) => {
  if (!Number.isInteger(page) || page < 1 || page > doc.pageCount) throw new Error('页码超出范围。');
};
export class DocumentAnalysis {
  constructor({ worker, mineru }) { Object.assign(this, { worker, mineru }); this.layouts = new Map(); this.jobs = new Map(); }
  file(doc) { return join(doc.cacheDir, 'ocr-v1.json'); }
  async record(doc) { return jsonFile(this.file(doc), { source: 'original', pages: {} }); }
  async status(doc) {
    const record = await this.record(doc);
    const job = this.jobs.get(doc.id);
    return { configured: await this.mineru.configured(), source: record.source,
      pages: Object.keys(record.pages).map(Number),
      job: job ? { id: job.id, state: job.state, done: job.done, total: job.total, from: job.from, to: job.to, error: job.error || '' } : null };
  }
  async setSource(doc, source) {
    if (!['original', 'ocr'].includes(source)) throw new Error('未知的文字来源。');
    const record = await this.record(doc);
    if (source === 'ocr' && !Object.keys(record.pages).length) throw new Error('请先识别至少一页。');
    await atomicJSON(this.file(doc), { ...record, source });
    return this.status(doc);
  }
  async pageText(doc, page) {
    const record = await this.record(doc);
    return record.source === 'ocr' ? record.pages[page]?.text : undefined;
  }
  async layout(doc, page) {
    validPage(doc, page);
    const key = `${doc.id}:${page}`;
    if (!this.layouts.has(key)) {
      const file = join(doc.cacheDir, `layout-v1-${page}.json`);
      const pending = (async () => {
        const cached = await jsonFile(file, null);
        if (cached?.engine === 'pp-doclayout-v2') return cached;
        const result = await this.worker.call({ op: 'layout', path: doc.path, page });
        if (result.engine === 'pp-doclayout-v2') await atomicJSON(file, result);
        return result;
      })().catch(error => { this.layouts.delete(key); throw error; });
      this.layouts.set(key, pending);
      if (this.layouts.size > 60) this.layouts.delete(this.layouts.keys().next().value);
    }
    const result = await this.layouts.get(key);
    const record = await this.record(doc);
    const ocr = record.source === 'ocr' ? record.pages[page] : null;
    if (!ocr) return { ...result, page, textSource: 'original' };
    const blocks = result.blocks.map(block => {
      const match = ocr.blocks.filter(b => b.text && iou(b.rect, block.rect) > 0.25).sort((a, b) => iou(b.rect, block.rect) - iou(a.rect, block.rect))[0];
      return { ...block, text: match?.text || block.text, textSource: match ? 'ocr' : 'original' };
    });
    // OCR may find blocks missed by the local detector (e.g. a faint scan).
    for (const b of ocr.blocks) if (!blocks.some(x => iou(x.rect, b.rect) > 0.25)) blocks.push({ ...b, textSource: 'ocr' });
    return { ...result, blocks, page, textSource: 'ocr' };
  }
  async start(doc, { scope = 'page', page = 1 }) {
    validPage(doc, page);
    if (!['page', 'document'].includes(scope)) throw new Error('未知的识别范围。');
    if (!(await this.mineru.configured())) throw new Error('尚未配置 MinerU API key，请运行 npm run configure-mineru。');
    const previous = this.jobs.get(doc.id);
    if (previous && !['done', 'failed', 'cancelled'].includes(previous.state)) throw new Error('这篇论文已有识别任务，请等待或先取消。');
    const from = scope === 'page' ? page : 1, to = scope === 'page' ? page : doc.pageCount;
    const job = { id: randomUUID(), state: 'preparing', from, to, total: to-from+1, done: 0, controller: new AbortController() };
    this.jobs.set(doc.id, job);
    job.promise = this.run(doc, job).catch(error => {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      // Network exception details can include signed URLs. Never forward them to the UI/logs.
      job.error = job.state === 'cancelled' ? '' : (/^(MinerU|PDF|尚未|本地|请先)/.test(error.message) ? error.message : '识别未完成，请检查网络后重试。');
    });
    return this.status(doc);
  }
  async run(doc, job) {
    const dir = await mkdtemp(join(tmpdir(), 'codex-zotero-ocr-'));
    try {
      for (let from = job.from; from <= job.to; from += 200) {
        const to = Math.min(job.to, from+199), file = join(dir, 'pages.pdf');
        job.controller.signal.throwIfAborted();
        job.state = 'preparing';
        await this.worker.call({ op: 'slice', path: doc.path, from, to, output: file });
        job.controller.signal.throwIfAborted();
        const pages = await this.mineru.recognize({ file, first: from, pageSizes: doc.pages.slice(from-1, to), signal: job.controller.signal,
          progress: state => { if (!job.controller.signal.aborted) job.state = state; } });
        job.controller.signal.throwIfAborted();
        const record = await this.record(doc);
        await atomicJSON(this.file(doc), { source: 'ocr', pages: { ...record.pages, ...pages } });
        job.done += to-from+1;
      }
      job.state = 'done';
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async cancel(doc) { const job = this.jobs.get(doc.id); job?.controller.abort(); if (job && job.state !== 'done') job.state = 'cancelled'; return this.status(doc); }
  close() { for (const job of this.jobs.values()) job.controller.abort(); this.worker.close(); }
}
