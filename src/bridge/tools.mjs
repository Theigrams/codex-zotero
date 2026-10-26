// A private transport for reading and model-authorized OCR. Never export panel internals.
import { z } from 'zod';
import { modelTools } from '../server/tools.mjs';
import { researchTools } from '../server/research.mjs';
import { modelToolMetadata } from '../server/tool-policy.mjs';

export const BRIDGE_TOOLS = Object.freeze([
  'reader_state', 'search_library', 'paper_outline', 'read_pages', 'find_in_paper',
  'list_annotations', 'read_notes', 'ocr_status', 'paper_full_text', 'ocr_start',
  'research_status', 'research_annotations', 'research_ocr_start', 'research_ocr_status', 'research_ocr_cancel',
]);
export const sessionSchema = z.string().regex(/^[a-f0-9]{32}$/);
export function bridgeDefinitions(tools = { ...modelTools({}), ...researchTools({}) }) {
  return Object.fromEntries(BRIDGE_TOOLS.map(name => {
    const tool = tools[name];
    if (!tool) throw new Error(`Missing bridge operation: ${name}`);
    // A remote conversation must never silently follow a different paper on screen.
    const schema = { ...tool.schema };
    if ('docId' in schema) schema.docId = z.string().regex(/^[a-f0-9]{16}$/);
    return [name, { ...tool, schema, metadata: modelToolMetadata(name) }];
  }));
}
export async function callBridgeTool(definitions, name, args) {
  if (!Object.hasOwn(definitions, name)) throw new Error('该操作未向远程连接开放。');
  const tool = definitions[name];
  const validated = z.object(tool.schema).strict().parse(args);
  return tool.run(validated);
}
