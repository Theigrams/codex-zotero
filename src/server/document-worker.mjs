// A bounded JSON-lines worker. The layout model stays resident; PDF slicing uses the same local runtime.
import { spawn } from 'node:child_process';
export class DocumentWorker {
  constructor({ python, script, model }) { Object.assign(this, { python, script, model }); this.pending = new Map(); this.next = 0; }
  start() {
    if (this.proc) return;
    if (!this.python) throw new Error('请先安装本地分析环境：npm run setup-analysis');
    const proc = this.proc = spawn(this.python, ['-I', this.script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return proc.kill();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        let r;
        try { r = JSON.parse(buffer.slice(0, at)); } catch { proc.kill(); return; }
        buffer = buffer.slice(at + 1);
        const p = this.pending.get(r.id);
        if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(r.id);
        r.ok ? p.resolve(r) : p.reject(new Error(r.error));
      }
    });
    const stop = () => {
      if (this.proc === proc) this.proc = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('本地分析进程停止，请重试。')); }
      this.pending.clear();
    };
    proc.on('exit', stop); proc.on('error', stop);
  }
  call(request) {
    this.start();
    if (this.pending.size >= 16) return Promise.reject(new Error('本地分析繁忙，请稍后重试。'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.proc?.kill(); reject(new Error('本地分析超时，请重试。')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...request, model: this.model, id }) + '\n', error => { if (error) this.proc?.kill(); });
    });
  }
  close() { this.proc?.kill(); }
}
