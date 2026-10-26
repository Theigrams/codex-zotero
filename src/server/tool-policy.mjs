// Be explicit: omitted MCP annotations default to a potentially destructive write.
const readOnly = new Set([
  'reader_state', 'paper_context', 'paper_outline', 'paper_map', 'reading_guide',
  'read_pages', 'find_in_paper', 'list_annotations', 'read_notes', 'search_annotations',
  'page_layout', 'ocr_status', 'paper_full_text', 'search_library',
  'research_status', 'research_annotations', 'research_ocr_status',
]);
const writes = {
  annotate: [true, false], update_annotation: [true, false], delete_annotation: [true, false],
  reading_note_save: [true, false], paper_map_generate: [true, true], show_location: [false, false],
  ocr_start: [false, true], research_ocr_start: [false, true], research_ocr_cancel: [true, false],
};

export function modelToolMetadata(name) {
  if (!readOnly.has(name) && !Object.hasOwn(writes, name)) throw new Error(`Missing tool policy: ${name}`);
  const [destructiveHint, openWorldHint] = writes[name] || [false, false];
  return {
    annotations: { readOnlyHint: readOnly.has(name), destructiveHint, openWorldHint },
    _meta: { ui: { visibility: ['model', 'app'] } },
  };
}

export function modelToolResult(name, result) {
  if (name.startsWith('research_')) {
    const { text, ...data } = result;
    return { content: [{ type: 'text', text: text || JSON.stringify(result) }], structuredContent: data };
  }
  return { content: [{ type: 'text', text: result.text || 'ok' }], structuredContent: result.data || {} };
}
