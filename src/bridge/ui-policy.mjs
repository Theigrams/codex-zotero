// Only explicit reader UI operations cross the private tunnel. Credentials/files stay local.
import { z } from 'zod';
import { appSchemas } from '../server/app-schemas.mjs';
export const REMOTE_UI_TOOLS=Object.freeze([
  'panel_hello','panel_poll','panel_report','home_list','tab_open','tab_close','tab_order',
  'render_strip','render_page','render_preview','position_save','page_text','selection_image','page_links',
  'annotations_list','annotation_create','annotation_update','annotation_delete','annotation_undo','annotation_retry',
  'layout_page','ocr_job_status','ocr_job_start','ocr_job_cancel',
  'prefs_get','prefs_set','notes_list','note_position_save','note_jump','map_generate',
  'research_choose','research_candidates','research_prepare','research_preview_data',
]);
export const REMOTE_READS=new Set(['home_list','render_strip','render_page','render_preview','page_text','selection_image','page_links','annotations_list','layout_page','ocr_job_status','prefs_get','notes_list','research_candidates','research_prepare','research_preview_data','research_choose']);
export function validateRemoteAppCall(name,args) {
  if(!REMOTE_UI_TOOLS.includes(name))throw new Error('此操作仅允许在本机设置中执行。');
  return z.object(appSchemas[name]).strict().parse(args);
}
export const REMOTE_READER_URI='ui://codex-zotero/remote-reader-v2.html';
