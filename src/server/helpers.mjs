// A small pool of long-lived PDFKit helper processes (native/PDFKitHelper.swift, JSON-lines).
import { spawn } from 'node:child_process';

class Helper {
  constructor(bin) {
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.pending = new Map();
    this.next = 1;
    this.busy = false;
    let buffer = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        const p = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (p) reply.ok ? p.resolve(reply) : p.reject(new Error(reply.error));
      }
    });
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('PDFKit helper exited'));
      this.pending.clear();
    });
  }

  call(req) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ ...req, id }) + '\n');
    });
  }
}

export class HelperPool {
  constructor(bin, size = 2) {
    this.helpers = Array.from({ length: size }, () => new Helper(bin));
    this.handles = new Map(); // pdf path → per-helper document handle
    this.queue = [];
    this.seq = 0;
  }

  // Opens the PDF in every helper (once) and returns the first helper's page list.
  async open(path) {
    if (this.handles.has(path)) return this.handles.get(path).info;
    const replies = await Promise.all(this.helpers.map(h => h.call({ op: 'open', path })));
    const info = { pageCount: replies[0].pageCount, pages: replies[0].pages };
    this.handles.set(path, { docs: replies.map(r => r.doc), info });
    return info;
  }

  // Runs one request on whichever helper frees up first; lower priority numbers go first.
  run(path, req, priority = 2) {
    if (!this.handles.has(path)) return Promise.reject(new Error('document not open'));
    return new Promise((resolve, reject) => {
      this.queue.push({ path, req, priority, seq: this.seq++, resolve, reject });
      this.pump();
    });
  }

  pump() {
    this.helpers.forEach((h, i) => {
      if (h.busy || !this.queue.length) return;
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = this.queue.shift();
      h.busy = true;
      h.call({ ...job.req, doc: this.handles.get(job.path).docs[i] })
        .then(job.resolve, job.reject)
        .finally(() => { h.busy = false; this.pump(); });
    });
  }

  close() {
    for (const h of this.helpers) h.proc.kill();
  }
}
