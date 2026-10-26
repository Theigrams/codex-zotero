export const MAX_RESEARCH_PAPERS = 20;
export const RESEARCH_GOALS = ['比较研究方法与实验结果', '撰写文献综述', '梳理研究脉络与研究空白'];
export const paperUri = key => `zotero://paper/${key}`;
export const paperKey = uri => typeof uri === 'string' ? uri.match(/^zotero:\/\/paper\/([A-Z0-9]{8})$/)?.[1] : undefined;

export function researchContent(research, extended = false) {
  if (!research?.papers?.length) return [];
  return research.papers.map((p,index) => ({ type: 'text', text: `研究文献：《${p.title}》\nitemKey=${p.itemKey}${p.docId ? `；docId=${p.docId}` : ''}。${p.fullText?.available ? `已有 MinerU 全文，版本 ${p.fullText.version}。` : '尚无完整 MinerU 全文。'}\n${index ? '同组研究文献。' : `阅读目标：${research.objective || '根据用户的问题分析'}。${research.includeAnnotations !== false ? '分析时按需调用 research_annotations 读取高亮和评论，区分用户观点与论文原文。' : '当前研究未选择结合用户批注。'}\n需要完整正文时，先用 research_status 检查这一组论文；缺少全文且全局允许时调用 research_ocr_start，完成后逐篇 paper_full_text 分页读取。同一对话已读的全文版本应复用。选择文献本身不表示立即上传。`}`,
    ...(extended ? { _meta: { 'openai/title': p.title, 'openai/group': { title: '研究文献' }, 'zotero/paperKey': p.itemKey,
      ...(p.thumbnail ? { 'openai/thumbnail': { src: p.thumbnail, mimeType: 'image/png' } } : {}) } } : {}) }));
}
