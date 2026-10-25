// What reaches the Codex conversation: the reading context kept up to date in the background
// (updateModelContext — the host keeps only the latest one). Questions are written in the native
// composer; the reader prepares context without changing the current draft.

import { researchContent } from '../shared/research.mjs';
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
    this.annotationStates = new Map();
    window.__sent = [];
  }

  setReadingTools(names) { this.readingTools = [...names]; this.schedule(); }

  setAnnotationStatus(docId, state) {
    if (JSON.stringify(this.annotationStates.get(docId)) === JSON.stringify(state)) return;
    this.annotationStates.set(docId, state);
    this.schedule();
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
      const session = this.readerSession ? `\n[私有远程桥接] readerSession=${this.readerSession}。仅在本轮实际具有远程 Zotero 工具时使用该连接。` : '';
      return { text: (this.elsewhere || '[Zotero 阅读器] 面板在首页，没有打开论文。') + session, structured: { document: null, view: this.elsewhere ? 'note' : 'home', ...(this.readerSession ? {readingAccess:{readerSession:this.readerSession,modelToolExposure:'unknown'}} : {}) } };
    }
    const d = this.reader.doc;
    const page = this.reader.currentPage();
    const [a, b] = this.reader.range(0);
    const sel = this.selection.current;
    const lines = [`[Zotero 阅读器] 用户正在读${this.source()}，第 ${page} / ${d.pageCount} 页（屏幕上是第 ${a}${b > a ? `–${b}` : ''} 页）。`];
    if (this.readerSession) lines.push(`[私有远程桥接] readerSession=${this.readerSession}，docId=${d.id}。若本轮具有远程 Zotero 阅读工具，使用这两个标识读取当前论文；不要自动选择其他阅读器连接。远程工具是否已连接仍由宿主决定。`);
    const fullText = this.fullTexts.get(d.id);
    const retrieval = fullTextContext(d.id, fullText);
    if (retrieval) lines.push(retrieval);
    lines.push('[读取能力边界] 阅读器提供的文档信息和缓存状态不代表当前对话已获得读取工具。仅使用本轮实际暴露的工具读取正文；工具名出现在上下文中，不代表工具可调用。若没有读取工具，明确说明本轮无法读取。阅读器面板不是普通浏览器标签，不要尝试连接浏览器来寻找这些工具，也不要根据标题推测全文。');
    if(this.readingTools?.includes('reader_read_full_text')) lines.push('[页面注册状态] 页面内已注册 reader_read_full_text（缓存全文）、reader_read_pages（本机页文字）、reader_read_annotations（高亮与评论）；是否向本轮模型暴露由宿主决定，当前页面无法确认。只有它们确实出现在可调用工具列表中时才使用。读取本机论文不是联网搜索。');
    const annotationState = this.annotationStates.get(d.id);
    if (annotationState) lines.push(`[用户批注] ${annotationState.count} 条批注，${annotationState.comments} 条评论；版本 ${annotationState.version || '未同步'}。用户问及标注或自己的想法时，使用 ${d.itemKey ? 'research_annotations(itemKey)' : 'list_annotations(docId)'} 读取原文与评论。${annotationState.error ? '当前为缓存，Zotero 暂不可用。' : ''}`);
    if (sel?.kind === 'text') lines.push(`用户选中了第 ${sel.page} 页的这段文字：「${clip(sel.text)}」`);
    if (sel?.kind === 'region') lines.push(`用户框选了第 ${sel.page} 页的一块区域（多为公式或图），位置 [${sel.rect.map(v => Math.round(v)).join(', ')}] pt。`);
    return {
      text: lines.join('\n'),
      structured: {
        document: { id: d.id, title: d.title, itemKey: d.itemKey, attachmentKey: d.attachmentKey, pageCount: d.pageCount },
        page, visible: [a, b], readingAccess: { registeredPageTools: this.readingTools || [], modelToolExposure: 'unknown', ...(this.readerSession ? {readerSession:this.readerSession} : {}) }, ...(fullText ? { fullText } : {}), ...(annotationState ? { annotations: annotationState } : {}),
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
    const signature = text + JSON.stringify((this.contextBlocks?.items || []).map(b => b.id)) + (this.research?.signature() || '');
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
    if (this.research) content.push(...researchContent(this.research.structured(), !!this.host.extensions?.modelContext));
    const params = { content, structuredContent: { ...structured, ...(this.research ? {research:this.research.structured()} : {}), contextBlocks: blocks.map(({ image, ...b }) => b) } };
    this.publishQueue = (this.publishQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.host.extensions?.modelContext) {
        if (this.contextBlocks) this.contextBlocks.publishing = true;
        if (this.research) this.research.publishing = true;
        let result;
        try { result = await this.host.extensions.modelContext.update(params); }
        finally { this.contextBlocks?.endPublish(result?.updateId); this.research?.endPublish(result?.updateId); }
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

  // One composer: publish attachments and keep the complete reader expanded.
  // Never append a prompt to (or submit) a draft the user may already be editing.
  async continueInChat({ addSelection = false } = {}) {
    if (this.handingOff) return;
    this.handingOff = true;
    try {
      if (addSelection && !await this.contextBlocks?.add()) return;
      await this.sync();
      await this.publishQueue;
      // The complete reader stays expanded. The host owns the native composer;
      // preparing context must not collapse the reader or modify its draft.
      return true;
    } finally { this.handingOff = false; }
  }

  // New conversations do not inherit this app's model context. Only this explicit
  // action creates a draft, carrying the paper identity and the pinned blocks once.
  async draftNewConversation() {
    if (this.sending) return;
    if (!this.host.extensions?.message) throw new Error('当前宿主不支持新对话草稿，请在对话框中提问。');
    const d = this.reader.doc;
    if (!d) throw new Error('请先打开论文。');
    this.sending = true;
    try {
      const blocks = [...(this.contextBlocks?.items || [])];
      const images = this.host.app?.getHostCapabilities()?.message?.image !== undefined;
      const content = [{ type: 'text', text: `关于${this.source()}（docId ${d.id}，共 ${d.pageCount} 页）：` },
        ...contextContent('', blocks, { extended: true, images }).slice(1),
        ...researchContent(this.research?.structured(), true)];
      const result = await this.host.extensions.message.send({ role: 'user', content,
        _meta: { 'openai/message': { target: 'new', send: false } } });
      if (result?.isError) throw new Error('ChatGPT 没有接收新对话草稿。');
    } finally { this.sending = false; }
  }
}
