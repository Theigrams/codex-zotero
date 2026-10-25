const $ = id => document.getElementById(id);
const LABELS = { preparing:'正在准备页面…', uploading:'正在上传…', 'waiting-file':'等待接收…', pending:'正在排队…', running:'正在识别…', converting:'正在整理结果…', done:'识别完成', cancelled:'已取消', failed:'识别失败' };
export class OcrPanel {
  constructor({ reader, call, onChanged, onError }) {
    Object.assign(this, { reader, call, onChanged, onError }); this.generation = 0;
    $('ocrPage').onclick = () => this.start('page'); $('ocrDocument').onclick = () => this.start('document');
    $('ocrCancel').onclick = async () => { try { await this.call('ocr_job_cancel', { docId:this.reader.doc.id }); this.refresh(); } catch(e) { this.onError(e.message); } };
    $('ocrClose').onclick = () => this.close();
    $('ocrSource').onchange = async () => { try { await this.call('ocr_text_source', { docId:this.reader.doc.id, source:$('ocrSource').value }); this.onChanged(); this.refresh(); } catch(e) { this.onError(e.message); } };
  }
  updatePage() { if (this.reader.doc) $('ocrPage').textContent = `识别本页（第 ${this.reader.currentPage()} 页）`; }
  open() { if (!this.reader.doc) return; $('ocrPanel').hidden = false; this.refresh(); }
  close() { $('ocrPanel').hidden = true; $('ocrButton').setAttribute('aria-expanded', 'false'); }
  reset() { this.generation++; clearTimeout(this.timer); this.close(); this.lastDone = null; }
  async start(scope) {
    const doc = this.reader.doc; if (!doc) return;
    $('ocrPage').disabled = true; $('ocrDocument').disabled = true;
    try { await this.call('ocr_job_start', { docId:doc.id, scope, page:this.reader.currentPage() }); this.refresh(); }
    catch(e) { this.onError(e.message); this.refresh(); }
  }
  async refresh() {
    clearTimeout(this.timer);
    const doc = this.reader.doc, generation = this.generation; if (!doc) return;
    try {
      const r = await this.call('ocr_job_status', { docId:doc.id });
      if (generation !== this.generation || this.reader.doc?.id !== doc.id) return;
      const job = r.job, busy = job && !['done','failed','cancelled'].includes(job.state);
      $('ocrStatus').textContent = job ? `${LABELS[job.state] || '处理中…'}${busy ? ` ${job.done} / ${job.total} 页` : ''}${job.error ? `：${job.error}` : ''}` : '尚未启动高精度识别';
      $('ocrPage').textContent = `识别本页（第 ${this.reader.currentPage()} 页）`;
      $('ocrDocument').textContent = `识别整篇（${doc.pageCount} 页）`;
      $('ocrPage').disabled = !r.configured || busy; $('ocrDocument').disabled = !r.configured || busy;
      $('ocrCancel').hidden = !busy; $('ocrSource').value = r.source; $('ocrSource').options[1].disabled = !r.pages.length;
      $('ocrCached').textContent = r.pages.length ? `已识别 ${r.pages.length} 页；未识别的页面继续使用原文。` : '原文由本机提取；识别结果单独缓存。';
      $('ocrConfig').hidden = r.configured;
      $('ocrBadge').textContent = busy ? '识别中' : r.source === 'ocr' ? 'OCR' : 'OCR…';
      const complete = job?.state === 'done' ? job.id : null;
      if (complete && complete !== this.lastDone) { this.lastDone = complete; this.onChanged(); }
      if (busy) this.timer = setTimeout(() => this.refresh(), 2000);
    } catch(e) { if (generation === this.generation) this.onError(e.message); }
  }
}
