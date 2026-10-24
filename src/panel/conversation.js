// What reaches the Codex conversation: the reading context kept up to date in the background
// (updateModelContext — the host keeps only the latest one, spike S11) and questions sent with the
// original-image crop (sendMessage). In the browser preflight both are recorded on window.__sent instead.

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
    window.__sent = [];
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
    if (sel?.kind === 'text') lines.push(`用户选中了第 ${sel.page} 页的这段文字：「${clip(sel.text)}」`);
    if (sel?.kind === 'region') lines.push(`用户框选了第 ${sel.page} 页的一块区域（多为公式或图），位置 [${sel.rect.map(v => Math.round(v)).join(', ')}] pt。`);
    return {
      text: lines.join('\n'),
      structured: {
        document: { id: d.id, title: d.title, itemKey: d.itemKey, attachmentKey: d.attachmentKey, pageCount: d.pageCount },
        page, visible: [a, b],
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
    if (text === this.lastContext) return;
    this.lastContext = text;
    const report = this.reader.doc && !this.elsewhere ? { view: 'paper', ...this.report() }
      : { view: this.note ? 'note' : 'home', note: this.note, docId: null };
    this.host.call('panel_report', report).catch(() => {});
    await this.publish(text, structured);
  }

  async publish(text, structured) {
    if (this.host.app) await this.host.app.updateModelContext({ content: [{ type: 'text', text }], structuredContent: structured });
    else window.__sent.push({ kind: 'context', text });
  }

  // Every panel keeps the last context it sent; a panel that a newer one replaced says so, so the model
  // doesn't take its stale page or selection for what the user is reading now.
  retire() {
    clearTimeout(this.timer);
    this.lastContext = '';
    return this.publish('[Zotero 阅读器] 这个面板已被新打开的阅读器面板取代；以较新的阅读器上下文为准。', { document: null, view: 'retired' }).catch(() => {});
  }

  // Sends the question with the selection's text and an original-image crop (formulas are judged from the image).
  async ask(question) {
    const sel = this.selection.current;
    if (!sel) throw new Error('没有选区。');
    const d = this.reader.doc;
    const img = await this.host.call('selection_image', { docId: d.id, page: sel.page, rect: this.selection.bounds() });
    const quote = sel.kind === 'text'
      ? `> 选段：${this.source()}第 ${sel.page} 页\n> 「${clip(sel.text)}」\n（附原文截图；公式与符号以截图为准）`
      : `> 框选：${this.source()}第 ${sel.page} 页的一块区域（见截图）`;
    const text = `${question.trim() || '请解释这段内容。'}\n\n${quote}`;
    // The server keeps this selection, so the answer can be saved on it after the user clicked elsewhere.
    this.host.call('panel_report', { view: 'paper', ...this.report(), asked: this.report().selection }).catch(() => {});
    const canImage = !this.host.app || this.host.app.getHostCapabilities()?.message?.image !== undefined;
    const content = [{ type: 'text', text }, ...(canImage ? [{ type: 'image', data: img.data, mimeType: 'image/png' }] : [])];
    if (this.host.app) {
      const r = await this.host.app.sendMessage({ role: 'user', content });
      if (r?.isError) throw new Error('Codex 没有接收这条消息。');
    } else {
      window.__sent.push({ kind: 'message', text, image: canImage ? `${img.width}x${img.height}` : null });
    }
  }
}
