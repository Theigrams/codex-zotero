const $ = id => document.getElementById(id);
const LABELS = { preparing:'正在准备整篇…', uploading:'正在上传…', 'waiting-file':'等待接收…', pending:'正在排队…', running:'正在识别…', converting:'正在整理结果…', downloading:'正在下载识别结果…', finalizing:'正在整理全文…', committing:'正在保存全文…', done:'识别完成', cancelled:'已取消', failed:'识别失败' };
export class OcrPanel {
  constructor({ reader, call, onChanged, onStatus, onError }) {
    Object.assign(this, { reader, call, onChanged, onStatus, onError }); this.generation = 0;
    $('ocrDocument').onclick = () => this.start();
    $('ocrCancel').onclick = async () => { try { await this.call('ocr_job_cancel', { docId:this.reader.doc.id }); this.refresh(); } catch(e) { this.onError(e.message); } };
    $('ocrClose').onclick = () => this.close();
  }
  open() { if (!this.reader.doc) return; $('ocrPanel').hidden = false; this.refresh(); }
  close() { $('ocrPanel').hidden = true; $('ocrButton').setAttribute('aria-expanded', 'false'); }
  reset() { this.generation++; clearTimeout(this.timer); this.close(); this.lastVersion = null; this.lastDone = null; this.status = null; }
  async start() {
    const doc = this.reader.doc; if (!doc || this.starting) return;
    this.starting = true; $('ocrDocument').disabled = true;
    try { await this.call('ocr_job_start', { docId: doc.id, force: !!this.status?.complete }); }
    catch(e) { this.onError(e.message); }
    finally { this.starting = false; this.refresh(); }
  }
  async refresh() {
    clearTimeout(this.timer);
    const doc = this.reader.doc, generation = this.generation; if (!doc) return;
    // Ignore out-of-order poll responses (a settings save can trigger another poll).
    const request = this.request = (this.request || 0) + 1;
    try {
      const r = await this.call('ocr_job_status', { docId:doc.id });
      if (generation !== this.generation || this.reader.doc?.id !== doc.id || request !== this.request) return;
      if (typeof r.complete !== 'boolean') {
        $('ocrStatus').textContent = '插件已更新，请重启 Codex 以启用全文功能。';
        $('ocrDocument').disabled = true;
        return;
      }
      this.status = r;
      const job = r.job, busy = job && !['done','failed','cancelled'].includes(job.state);
      $('ocrStatus').textContent = job ? `${LABELS[job.state] || '处理中…'}${busy ? ` ${job.done} / ${job.total} 页` : ''}${job.error ? `：${job.error}` : ''}` : r.complete ? '完整结果已就绪' : '尚未识别整篇';
      $('ocrDocument').textContent = r.complete ? '重新识别整篇' : `识别整篇（${doc.pageCount} 页）`;
      $('ocrDocument').disabled = !r.configured || !!busy || this.starting;
      $('ocrCancel').hidden = !busy || job.state === 'committing';
      $('ocrCached').textContent = r.complete ? `已自动使用 MinerU 全文和版面 · ${doc.pageCount} 页` : r.pages.length ? `旧版缓存仅含 ${r.pages.length} 页；识别整篇后统一使用完整结果。` : '识别前使用本机提取的文字和版面。';
      $('ocrConfig').hidden = r.configured;
      $('ocrBadge').textContent = busy ? '识别中' : r.complete ? '全文' : 'OCR';
      this.onStatus?.(doc.id, r);
      const completed = job?.state === 'done' ? job.id : null;
      if (r.version !== this.lastVersion || (completed && completed !== this.lastDone)) {
        this.lastVersion = r.version; this.lastDone = completed; this.onChanged();
      }
      // A model can start OCR while this popover is closed. Publish completion on the next poll.
      this.timer = setTimeout(() => this.refresh(), busy ? 2000 : 15000);
    } catch(e) { if (generation === this.generation) { this.onError(e.message); this.timer = setTimeout(() => this.refresh(), 15000); } }
  }
}
