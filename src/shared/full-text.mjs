// The host has no guaranteed main-composer send receipt. Publish a small retrieval policy,
// never the body or a global "already sent" flag. The model's current conversation owns reuse.
export function fullTextDescriptor(status) {
  return {
    available: !!status.complete, version: status.version || null, characters: status.characters || 0,
    allowModelOcr: !!status.settings?.allowModelOcr,
  };
}
export function fullTextContext(docId, descriptor) {
  if (!descriptor) return '';
  const permission = descriptor.allowModelOcr
    ? '全局设置允许模型按需调用 ocr_start 识别整篇论文；仅在任务需要时发起。'
    : '未允许模型自主上传；只有用户明确要求识别时才能调用 ocr_start。';
  if (!descriptor.available) return `[全文上下文] 尚无完整 MinerU 结果。使用本机文字；可用 ocr_status 查询。${permission}`;
  const policy = '由模型按当前问题决定是否需要全文；需要且当前对话尚未读过此版本时调用 paper_full_text，否则不读取。';
  return `[全文上下文] docId=${docId}，MinerU 版本=${descriptor.version}，${descriptor.characters} 字符。${policy}分页时按 nextOffset 和 version 续读至结束；同一版本在当前对话已读完就直接复用，不逐轮重读。需要核对版本时可传 knownVersion 只取状态。上下文丢失后可按需重读。本提示不代表正文已发送。`;
}
