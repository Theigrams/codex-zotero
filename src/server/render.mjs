// Strip and preview rendering with an on-disk cache. Images travel to the panel as base64:
// Codex blocks panel requests to 127.0.0.1 (spike S1).
import { remotePagePlan } from '../shared/remote-page.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GRAY_GAMMA, fullRegion, pagePlan, previewPlan, stripsFor } from '../shared/layout.mjs';
const exec=promisify(execFile);

export class Renderer {
  constructor(pool, {python='',compressScript}={}) {
    Object.assign(this,{python,compressScript});
    this.pool = pool;
    this.inflight = new Map();
  }

  region(doc, page, crop) {
    const p = doc.pages[page - 1];
    if (!p) throw new Error('页码超出范围。');
    return crop ? doc.crops[page - 1] : fullRegion(p);
  }

  async strip(doc, { page, mode, cssWidth, dpr, index, crop = true, priority = 1 }) {
    const region = this.region(doc, page, crop);
    const plan = pagePlan(mode, cssWidth, dpr, { w: region[2], h: region[3] });
    const strip = stripsFor(plan)[index];
    if (!strip) throw new Error('条带序号超出范围。');
    const file = join(doc.cacheDir, `${crop ? 'c' : 'f'}-${plan.key}-p${page}-s${index}.png`);
    await this.ensure(doc, file, {
      op: 'render', page, region, scale: plan.scale, full: [plan.bitmapW, plan.bitmapH],
      tile: [0, strip.y, plan.bitmapW, strip.h], ...(plan.mode === 'aligned' ? { weight: GRAY_GAMMA } : {}),
    }, priority);
    return { data: (await readFile(file)).toString('base64'), plan, strip };
  }

  async page(doc, {page,cssWidth,dpr,crop=true,priority=0}) {
    const region=this.region(doc,page,crop);
    let density=dpr;
    for(let attempt=0;attempt<3;attempt++) {
      const plan=remotePagePlan(cssWidth,density,{w:region[2],h:region[3]});
      const file=join(doc.cacheDir,`${crop?'c':'f'}-${plan.key}-p${page}.png`);
      await this.ensure(doc,file,{op:'render',page,region,scale:plan.scale,full:[plan.bitmapW,plan.bitmapH],weight:GRAY_GAMMA},priority);
      const png=await readFile(file);
      const encoded=await this.compress(file,png);
      const bytes=encoded.bytes;
      if(bytes.length<=4*1024*1024)return {data:bytes.toString('base64'),mimeType:encoded.mimeType};
      // Even a noisy scan must fit the private transport, without splitting the page into requests.
      density=(plan.bitmapW/cssWidth)*Math.sqrt(3*1024*1024/bytes.length);
    }
    throw new Error('此页图片过大，请缩小后重试。');
  }

  async compress(file,png) {
    if(this.python && this.compressScript && this.webpUnavailable!==true) {
      const out=file+'.webp';
      try {
        try { await stat(out); }
        catch {
          if(!this.inflight.has(out))this.inflight.set(out,exec(this.python,['-I',this.compressScript,file,out],{timeout:15000,maxBuffer:16384}).finally(()=>this.inflight.delete(out)));
          await this.inflight.get(out);
        }
        const bytes=await readFile(out);
        if(bytes.length<png.length)return {bytes,mimeType:'image/webp'};
      } catch { this.webpUnavailable=true; } // Optional Pillow support; PDFKit PNG always remains available.
    }
    return {bytes:png,mimeType:'image/png'};
  }

  async preview(doc, { page, crop = true }) {
    const region = this.region(doc, page, crop);
    const plan = previewPlan({ w: region[2], h: region[3] });
    const file = join(doc.cacheDir, `${crop ? 'c' : 'f'}-preview-p${page}.png`);
    await this.ensure(doc, file, {
      op: 'render', page, region, scale: plan.scale, full: [plan.bitmapW, plan.bitmapH],
    }, 3);
    return { data: (await readFile(file)).toString('base64') };
  }

  // The original-image crop sent with a question: the selection (or region) padded a little,
  // about 3× its point size and at most 1800px wide, no post-processing.
  async crop(doc, { page, rect, scale: maxScale = 3 }) {
    const p = doc.pages[page - 1];
    if (!p) throw new Error('页码超出范围。');
    const pad = 6;
    const x0 = Math.max(0, rect[0] - pad), y0 = Math.max(0, rect[1] - pad);
    const x1 = Math.min(p.width, rect[0] + rect[2] + pad), y1 = Math.min(p.height, rect[1] + rect[3] + pad);
    if (x1 - x0 < 1 || y1 - y0 < 1) throw new Error('选区太小。');
    const region = [x0, y0, x1 - x0, y1 - y0];
    const scale = Math.min(maxScale, 1800 / region[2], 4000 / region[3]);
    const full = [Math.max(1, Math.round(region[2] * scale)), Math.max(1, Math.round(region[3] * scale))];
    const file = join(doc.cacheDir, `crop-${randomUUID()}.png`);
    await this.pool.run(doc.path, { op: 'render', page, region, scale, full, out: file }, 0);
    try {
      return { data: (await readFile(file)).toString('base64'), width: full[0], height: full[1] };
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  async ensure(doc, file, req, priority) {
    try {
      await stat(file);
      return;
    } catch {}
    if (!this.inflight.has(file)) {
      this.inflight.set(file, this.pool.run(doc.path, { ...req, out: file }, priority).finally(() => this.inflight.delete(file)));
    }
    await this.inflight.get(file);
  }
}
