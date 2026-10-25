// Page text for selection: PDFKit glyph boxes merged with MuPDF's repaired text, cached per page.
// MuPDF runs in a long-lived Python process (native/text_server.py). Without Python the PDFKit text is used
// unrepaired, so the reader keeps working on machines without PyMuPDF.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './files.mjs';
import { mergeText, packGlyphs } from './textlayer.mjs';

const TEXT_VERSION = 1;

class PythonText {
  constructor(python, script) {
    this.proc = spawn(python, ['-I', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.pending = new Map();
    this.next = 1;
    this.alive = true;
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
        if (p) reply.ok ? p.resolve(reply.chars) : p.reject(new Error(reply.error));
      }
    });
    const fail = () => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new Error('MuPDF text process stopped'));
      this.pending.clear();
    };
    this.proc.on('exit', fail);
    this.proc.on('error', fail);
  }

  page(path, page) {
    if (!this.alive) return Promise.reject(new Error('MuPDF text process unavailable'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, path, page }) + '\n');
    });
  }

  close() {
    this.proc.kill();
  }
}

export class TextService {
  constructor({ pool, python, script }) {
    this.pool = pool;
    this.python = python;
    this.script = script;
    this.mupdf = null;
    this.inflight = new Map();
  }

  async repairer() {
    if (this.mupdf === null) {
      try {
        await access(this.python);
        this.mupdf = new PythonText(this.python, this.script);
      } catch {
        this.mupdf = false;
      }
    }
    return this.mupdf && this.mupdf.alive ? this.mupdf : null;
  }

  // → { t: [glyph strings], b: flat rects (page points, top-left), l: line numbers, repaired: bool }
  // priority: helper queue order (lower first); background warm-up passes a high number so it never delays the screen.
  async page(doc, page, priority = 1) {
    const file = join(doc.cacheDir, `text-v${TEXT_VERSION}-p${page}.json`);
    const key = `${doc.id}:${page}`;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, (async () => {
        try {
          return JSON.parse(await readFile(file, 'utf8'));
        } catch {}
        const pk = await this.pool.run(doc.path, { op: 'chars', page }, priority);
        const mupdf = await this.repairer();
        const mu = mupdf ? await mupdf.page(doc.path, page).catch(() => null) : null;
        const packed = { ...packGlyphs(mergeText(pk, mu)), repaired: !!mu };
        if (mu) await atomicJSON(file, packed); // unrepaired text is not cached, so a later run can repair it
        return packed;
      })().finally(() => this.inflight.delete(key)));
    }
    const native = await this.inflight.get(key);
    const fullText = await this.ocrText?.(doc, page);
    return fullText !== undefined ? { ...native, fullText, textSource: 'ocr' } : { ...native, textSource: 'original' };
  }

  close() {
    if (this.mupdf) this.mupdf.close();
  }
}
