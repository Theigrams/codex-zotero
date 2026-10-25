import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { localApi } from './zotero.mjs';
import { readerDeepLink } from '../shared/reader-links.mjs';
import { OpenAIFormResultSchema } from '@openai/mcp-extensions';

export function registerExtensions(server, { state, searchLibrary, prefsChanged, readItem = localApi }) {
  const extensions = new OpenAIExtensions(server);
  const values = async () => {
    const p = await state.prefs();
    return { layoutEnabled: p.layoutEnabled, allowModelOcr: p.allowModelOcr, renderMode: p.renderMode };
  };
  extensions.settings.register({
    readTool: 'reader_settings_read', updateTool: 'reader_settings_update',
    fields: {
      layoutEnabled: { schema: z.boolean(), title: '本地版面识别', description: '在本机检测段落、公式、表格和图片，不上传论文。' },
      allowModelOcr: { schema: z.boolean(), title: '允许模型按需识别', description: '配置 MinerU key 后生效；模型需要时上传整篇，打开论文不会自动上传。' },
      renderMode: { schema: z.enum(['aligned', 'rounded']), title: 'PDF 渲染', description: 'aligned：像素对齐；rounded：半档缩放。' },
    },
    layout: [{ kind: 'group', title: '阅读与识别', items: [
      { kind: 'property', property: 'layoutEnabled' }, { kind: 'property', property: 'allowModelOcr' },
      { kind: 'property', property: 'renderMode' }, { kind: 'tool', tool: 'reader_settings', description: '填写 MinerU key，调整批注、快捷键与精读设置。' },
    ] }],
    read: values,
    update: async patch => { await state.setPrefs(patch); prefsChanged(); return values(); },
  });
  extensions.mentions.setHandler(async ({ query }) => {
    if (query.length > 200) throw new Error('搜索词过长。');
    const papers = query.trim() ? await searchLibrary(query, 20) : (await state.recent(20)).filter(p => p.itemKey).map(p => ({ key: p.itemKey, title: p.title }));
    const seen = new Set();
    return { items: papers.filter(p => !seen.has(p.key) && seen.add(p.key)).map(p => ({
      type: 'resource_link', uri: `zotero://paper/${p.key}`, name: p.title, title: p.title, mimeType: 'text/plain',
      description: [p.creators, p.year, 'Zotero 论文；按需读取正文'].filter(Boolean).join(' · '),
    })) };
  });
  server.registerTool('reader_choose', {
    title: '选择论文', description: 'Ask the user to choose a paper from Zotero search results using a native form when available. Returns the chosen itemKey; use reader_open to open it. Does not run OCR.',
    inputSchema: { query: z.string().min(1).max(200) }, annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    const items = await searchLibrary(query, 12);
    const caps = server.server.getClientCapabilities();
    if (!items.length || !(caps?.extensions?.['openai/elicitation']?.form || caps?.experimental?.['openai/elicitation']?.form)) {
      return { content: [{ type: 'text', text: JSON.stringify({ items, instruction: '请用户选择论文，再用 reader_open 打开。' }) }] };
    }
    // This server negotiates MCP SDK 1's protocol; SDK 2's MRTR flow is not used here.
    const answer = await server.server.request({ method: 'openai/elicitation/create', params: {
      mode: 'form', message: '选择要阅读的论文', requestedSchema: { type: 'object', required: ['itemKey'], properties: {
        itemKey: { type: 'string', title: '论文', oneOf: items.map(p => ({ const: p.key, title: p.title, description: [p.creators, p.year].filter(Boolean).join(' · ') })) },
      } },
    } }, OpenAIFormResultSchema);
    const chosen = answer.action === 'accept' && items.find(p => p.key === answer.content?.itemKey);
    if (answer.action === 'accept' && !chosen) throw new Error('所选论文不在搜索结果中。');
    return { content: [{ type: 'text', text: JSON.stringify(chosen || { cancelled: true }) }] };
  });
  server.registerResource('zotero-paper', new ResourceTemplate('zotero://paper/{itemKey}', { list: undefined }), { mimeType: 'text/plain' }, async (uri, { itemKey }) => {
    if (!/^[A-Z0-9]{8}$/.test(itemKey)) throw new Error('论文标识无效。');
    const item = await readItem(`items/${itemKey}`);
    const text = JSON.stringify({ title: item.data.title, itemKey, date: item.data.date,
      link: readerDeepLink({ itemKey }),
      instruction: '论文元数据，不是全文。需要时用 reader_open 打开该 itemKey，再按问题读取相关页或 paper_full_text；不要仅因引用而启动 OCR。' });
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
  });
  return extensions;
}
