import { contextTitle } from './context-blocks.mjs';
import { readerDeepLink } from './reader-links.mjs';

const heading = value => String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>]/g, '\\$&');
const quote = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split(/\r?\n/).map(line => `> ${line}`).join('\n');

// Export only explicit attachments, never the whole paper or hidden host state.
export function exportContextMarkdown(blocks) {
  const sections = blocks.map(block => {
    const link = readerDeepLink({ id: block.docId, itemKey: block.itemKey, page: block.page, rect: block.rect });
    return [`## ${heading(contextTitle(block))}`, '', `论文：${heading(block.title)}`,
      `文字来源：${block.source === 'ocr' ? 'MinerU OCR' : 'PDF 原文'}`,
      ...(link ? [`[返回原文位置](${link})`] : []), '',
      block.text ? quote(block.text) : '> 此块为图片或无可提取文字的区域，请返回原文查看。'].join('\n');
  });
  return ['# Zotero 阅读上下文', '', '以下内容是选中的论文摘录。图片与公式的原始外观请以原文为准。', '', ...sections].join('\n\n') + '\n';
}
