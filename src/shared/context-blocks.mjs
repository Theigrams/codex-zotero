// Context is explicit and bounded; page movement only updates the invisible reading-position block.
export const BLOCK_NAMES = { text: '段落', title: '标题', caption: '图注', formula: '公式', table: '表格', figure: '图片', region: '选区' };
export const MAX_CONTEXT_BLOCKS = 8;
export const contextTitle = block => `${block.contextNumber ? `上下文 ${block.contextNumber} · ` : ''}第 ${block.page} 页 · ${BLOCK_NAMES[block.type] || '选段'}`;
export function contextContent(background, blocks, { extended = false, images = false } = {}) {
  const content = [{ type: 'text', text: background, annotations: { audience: ['assistant'] } }];
  for (const block of blocks) {
    const title = contextTitle(block);
    const meta = extended ? {
      'openai/title': title, 'openai/group': { title: block.title },
      'zotero/blockId': block.id,
      ...(block.image ? { 'openai/thumbnail': { src: `data:image/png;base64,${block.image}`, mimeType: 'image/png' } } : {}),
    } : {};
    content.push({ type: 'text', text: `《${block.title}》${title}\n来源：${block.source === 'ocr' ? 'MinerU OCR' : 'PDF 原文'}；docId ${block.docId}；位置 ${JSON.stringify(block.rect)}\n${block.text || '此块为图像内容，请结合原图。'}`,
      ...(extended ? { _meta: meta } : {}) });
    if (images && block.image && ['formula', 'table', 'figure', 'region'].includes(block.type)) {
      content.push({ type: 'image', data: block.image, mimeType: 'image/png', ...(extended ? { _meta: { ...meta, 'openai/title': `${title}原图` } } : {}) });
    }
  }
  return content;
}
