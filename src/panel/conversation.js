// What reaches the Codex conversation: the reading context kept up to date in the background
// (updateModelContext — the host keeps only the latest one, spike S11) and questions sent with the
// original-image crop (sendMessage). In the browser preflight both are recorded on window.__sent instead.

import { contextContent } from '../shared/context-blocks.mjs';
import { fullTextDescriptor, fullTextContext } from '../shared/full-text.mjs';

const MAX_QUOTE = 1500;      // characters of selected text put into the context or a question
const CONTEXT_DELAY_MS = 600;

const clip = t => (t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE)}…` : t);

export class Conversation {
  constructor({ host, reader, selection }) {
    Object.assign(this, { host, reader, selection });
    this.timer = 0;
    this.lastContext = '';
    this.elsewhere = null; // what the panel shows when it isn't a paper (a note, the home page)
    this.note = null;      // { key, title } of the note on screen, if any
    this.fullTexts = new Map();
    window.__sent = [];
  }

  setFullTextStatus(docId, status) {
    const value = fullTextDescriptor(status);
    if (JSON.stringify(this.fullTexts.get(docId)) === JSON.stringify(value)) return;
    this.fullTexts.set(docId, value);
    this.schedule();
  }

  source() {
    const d = this.reader.doc;
    return `《${d.title}》${d.itemKey ? `（Zotero 条目 ${d.itemKey}）` : ''}`;
  }

  context() {
    if (this.elsewhere || !this.reader.doc) {
      return { text: this.elsewhere || '[Zotero 阅读器] 面板在首页，没有打开论文。', structured: { document: null, view: this.elsewhere ? 'note' : 'home' } };
    }
    const d = this.reader.doc;
    const page = this.reader.currentPage();
    const [a, b] = this.reader.range(0);
    const sel = this.selection.current;
    const lines = [`[Zotero 阅读器] 用户正在读${this.source()}，第 ${page} / ${d.pageCount} 页（屏幕上是第 ${a}${b > a ? `–${b}` : ''} 页）。`];
    const fullText = this.fullTexts.get(d.id);
    const retrieval = fullTextContext(d.id, fullText);
    if (retrieval) lines.push(retrieval);
    if (sel?.kind === 'text') lines.push(`用户选中了第 ${sel.page} 页的这段文字：「${clip(sel.text)}」`);
    if (sel?.kind === 'region') lines.push(`用户框选了第 ${sel.page} 页的一块区域（多为公式或图），位置 [${sel.rect.map(v => Math.round(v)).join(', ')}] pt。`);
    return {
      text: lines.join('\n'),
      structured: {
        document: { id: d.id, title: d.title, itemKey: d.itemKey, attachmentKey: d.attachmentKey, pageCount: d.pageCount },
        page, visible: [a, b], ...(fullText ? { fullText } : {}),
        selection: sel ? (sel.kind === 'text' ? { kind: 'text', page: sel.page, text: clip(sel.text) } : { kind: 'region', page: sel.page, rect: sel.rect }) : null,
      },
    };
  }

  // Page turns and selection changes call this; only the settled state is sent, and only when it changed.
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync().catch(() => {}), CONTEXT_DELAY_MS);
  }

  // The same state for the server, so the model's tools (reader_state, annotate with use_selection) see it too.
  report() {
    const s = this.selection.current;
    const [a, b] = this.reader.range(0);
    return {
      docId: this.reader.doc.id, page: this.reader.currentPage(), visible: [a, b],
      selection: !s ? null : s.kind === 'text'
        ? { kind: 'text', page: s.page, text: s.text.slice(0, 20000), rects: s.rects.slice(0, 200), a: s.a }
        : { kind: 'region', page: s.page, rect: s.rect },
    };
  }

  // A note or the home page took the panel (text describes it), or null when a paper is back.
  showing(text, note = null) {
    this.elsewhere = text;
    this.note = note;
    this.schedule();
  }

  async sync() {
    const { text, structured } = this.context();
    const signature = text + JSON.stringify((this.contextBlocks?.items || []).map(b => b.id));
    if (signature === this.lastContext) return;
    const report = this.reader.doc && !this.elsewhere ? { view: 'paper', ...this.report() }
      : { view: this.note ? 'note' : 'home', note: this.note, docId: null };
    this.host.call('panel_report', report).catch(() => {});
    await this.publish(text, structured);
    this.lastContext = signature;
  }

  async publish(text, structured) {
    const blocks = this.contextBlocks?.items || [];
    const content = contextContent(text, blocks, {
      extended: !!this.host.extensions?.modelContext,
      images: !!this.host.app?.getHostCapabilities()?.updateModelContext?.image,
    });
    const params = { content, structuredContent: { ...structured, contextBlocks: blocks.map(({ image, ...b }) => b) } };
    this.publishQueue = (this.publishQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.host.extensions?.modelContext) {
        if (this.contextBlocks) this.contextBlocks.publishing = true;
        let result;
        try { result = await this.host.extensions.modelContext.update(params); }
        finally { this.contextBlocks?.endPublish(result?.updateId); }
      }
      else if (this.host.app) await this.host.app.updateModelContext(params);
      else window.__sent.push({ kind: 'context', text, content, structured: params.structuredContent });
    });
    return this.publishQueue;
  }

  // Every panel keeps the last context it sent; a panel that a newer one replaced says so, so the model
  // doesn't take its stale page or selection for what the user is reading now.
  retire() {
    clearTimeout(this.timer);
    this.lastContext = '';
    return this.publish('[Zotero 阅读器] 这个面板已被新打开的阅读器面板取代；以较新的阅读器上下文为准。', { document: null, view: 'retired' }).catch(() => {});
  }

  // Sends the question with the selection's text and an original-image crop (formulas are judged from the image).
  async ask(question, { target = 'active', send = true, wholePaper = false } = {}) {
    if (this.sending) throw new Error('正在提交，请稍候。');
    if ((target !== 'active' || !send) && !this.host.extensions?.message) throw new Error('当前宿主不支持消息草稿，请在对话框中提问。');
    const sel = wholePaper ? null : this.selection.current;
    const d = this.reader.doc;
    if (!d) throw new Error('请先打开论文。');
    const report = this.report(), source = this.source(), blocks = [...(this.contextBlocks?.items || [])];
    const canImage = !this.host.app || this.host.app.getHostCapabilities()?.message?.image !== undefined;
    this.sending = true;
    try {
      const img = sel && canImage && await this.host.call('selection_image', { docId: d.id, page: sel.page, rect: this.selection.bounds() });
      const quote = !sel ? `> 正在阅读${source}，docId ${d.id}，共 ${d.pageCount} 页。需要原文时按需调用阅读工具。` : sel.kind === 'text'
        ? `> 选段：${source}第 ${sel.page} 页\n> 「${clip(sel.text)}」${img ? '\n（附原文截图；公式与符号以截图为准）' : ''}`
        : `> 框选：${source}第 ${sel.page} 页的一块区域${img ? '（见截图）' : ''}${sel.text ? `\n> ${clip(sel.text)}` : ''}`;
      const text = `${question.trim() || (sel ? '请解释这段内容。' : '请结合已加入的上下文，帮助我阅读这篇论文。')}\n\n${quote}`;
      // Keep retrieval policy in background context, not in the user's visible question.
      await this.sync();
      await this.publishQueue;
      // The server keeps this selection, so the answer can be saved on it after the user clicked elsewhere.
      if (sel && send) this.host.call('panel_report', { view: 'paper', ...report, asked: report.selection }).catch(() => {});
      const content = [{ type: 'text', text }, ...(canImage && img ? [{ type: 'image', data: img.data, mimeType: 'image/png' }] : [])];
      // A new conversation cannot see this panel's current model context.
      if (target === 'new') content.push(...contextContent('', blocks, { extended: true, images: canImage }).slice(1));
      if (this.host.app) {
        const r = this.host.extensions?.message
          ? await this.host.extensions.message.send({ role: 'user', content, _meta: { 'openai/message': { target, send } } })
          : await this.host.app.sendMessage({ role: 'user', content });
        if (r?.isError) throw new Error('Codex 没有接收这条消息。');
      } else {
        window.__sent.push({ kind: 'message', text, image: canImage && img ? `${img.width}x${img.height}` : null });
      }
    } finally { this.sending = false; }
  }
}
