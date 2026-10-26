// Shared contracts for local and remote reader UI.
import { z } from 'zod';
import { RENDER_MODES } from '../shared/layout.mjs';
import { researchKeys, researchTools } from './research.mjs';

const rect = z.array(z.number()).length(4);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const selectionSchema = z.object({
  kind: z.enum(['text', 'region']), page: z.number().int().min(1), text: z.string().max(20000).optional(),
  rects: z.array(rect).max(200).optional(), rect: rect.optional(), a: z.number().int().optional(),
});
export const appSchemas = {
  tunnel_status: {}, tunnel_install: {}, tunnel_start: {},
  tunnel_configure: {tunnelId:z.string().max(120),apiKey:z.string().max(4096).optional(),autoConnect:z.boolean().optional()},
  tunnel_stop: {clear:z.boolean().optional()},
  research_choose: { query: z.string().max(200).default('') },
  research_candidates: { query: z.string().max(200).default('') },
  research_prepare: { itemKeys: researchKeys },
  research_preview_data: { itemKey: z.string().regex(/^[A-Z0-9]{8}$/), page: z.number().int().min(1).default(1), detail: z.boolean().default(false) },
  ...Object.fromEntries(Object.entries(researchTools({})).map(([name, tool]) => [name, tool.schema])),
  document_file: { docId: z.string() },
  file_open: {},
  layout_page: { docId: z.string(), page: z.number().int().min(1) },
  ocr_job_status: { docId: z.string() },
  ocr_job_start: { docId: z.string(), force: z.boolean().optional() },
  ocr_job_cancel: { docId: z.string() },
  mineru_configure: { apiKey: z.string().min(1).max(4096) },
  prefs_get: {},
  panel_hello: { instance: z.string().max(40) },
  panel_poll: { instance: z.string().max(40), seen: z.number().int().min(0).optional() },
  tab_open: { docId: z.string().optional(), itemKey: z.string().regex(/^[A-Z0-9]{8}$/).optional() },
  tab_close: { docId: z.string() },
  tab_order: { tabs: z.array(z.string()).max(20), active: z.string().nullable() },
  home_list: { query: z.string().max(200).optional() },
  notes_list: { docId: z.string() },
  map_generate: { docId: z.string() },
  note_position_save: { key: z.string().regex(/^[A-Z0-9]{8}$/), top: z.number().min(0).max(1) },
  note_jump: {
    ref: z.string().max(20000).optional(), attachmentKey: z.string().regex(/^[A-Z0-9]{8}$/).optional(), page: z.number().int().min(1).optional(),
    x: z.number().optional(), y: z.number().optional(), kind: z.enum(['eq', 'fig', 'tab', 'alg']).optional(),
  },
  panel_report: {
    view: z.enum(['paper', 'note', 'home']).optional(), note: z.object({ key: z.string(), title: z.string() }).nullable().optional(),
    docId: z.string().nullable(), page: z.number().int().min(1).optional(), visible: z.array(z.number().int()).length(2).optional(),
    selection: selectionSchema.nullable().optional(),
    asked: selectionSchema.optional(),
  },
  render_strip: {
    docId: z.string(), page: z.number().int().min(1), mode: z.enum(RENDER_MODES), cssWidth: z.number().positive().max(8000),
    dpr: z.number().positive().max(4), index: z.number().int().min(0), crop: z.boolean().optional(), priority: z.number().int().min(0).max(3).optional(),
  },
  render_page: {docId:z.string(),page:z.number().int().min(1),cssWidth:z.number().positive().max(8000),dpr:z.number().positive().max(4),crop:z.boolean().optional(),priority:z.number().int().min(0).max(3).optional()},
  render_preview: { docId: z.string(), page: z.number().int().min(1), crop: z.boolean().optional() },
  position_save: { docId: z.string(), page: z.number().int().min(1), offset: z.number(), zoom: z.number() },
  prefs_set: {
    allowModelOcr: z.boolean().optional(),
    layoutEnabled: z.boolean().optional(),
    renderMode: z.enum(RENDER_MODES).optional(),
    palette: z.array(z.object({ color: z.string(), tag: z.string() })).max(9).nullable().optional(),
    keys: z.record(z.string(), z.string().nullable()).optional(),
    mapPrompt: z.string().max(20000).optional(), mapModel: z.string().max(60).optional(), mapEffort: z.enum(['', 'low', 'medium', 'high']).optional(), readingQuestions: z.string().max(20000).optional(),
  },
  page_text: { docId: z.string(), page: z.number().int().min(1) },
  selection_image: { docId: z.string(), page: z.number().int().min(1), rect, scale: z.number().positive().max(3).optional() },
  page_links: { docId: z.string(), page: z.number().int().min(1) },
  annotations_list: { docId: z.string(), since: z.string().optional() },
  annotation_create: {
    docId: z.string(), kind: z.enum(['text', 'region']), page: z.number().int().min(1), rects: z.array(rect).min(1).max(200),
    text: z.string().max(20000).optional(), offset: z.number().int().min(0).optional(), color: color.optional(), type: z.enum(['highlight', 'underline']).optional(),
  },
  annotation_update: { docId: z.string(), key: z.string().regex(/^[A-Z0-9]{8}$/), comment: z.string().max(20000).optional(), color: color.optional() },
  annotation_delete: { docId: z.string(), key: z.string().regex(/^[A-Z0-9]{8}$/) },
  annotation_undo: { docId: z.string() },
  annotation_retry: { docId: z.string(), id: z.string().optional(), discard: z.boolean().optional() },
};

