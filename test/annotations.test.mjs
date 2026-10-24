import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromZotero, rectFromZotero, rectToZotero, tagsForColor, toZotero } from '../src/shared/annotations.mjs';
import { Annotations } from '../src/server/annotations.mjs';
import { zoteroClient } from '../src/server/zotero.mjs';
import { fakeZotero } from './fake-zotero.mjs';

const pages = [{ width: 595, height: 842, originX: 0, originY: 0, label: '1' }, { width: 595, height: 842, originX: 0, originY: 0, label: '2' }];
const doc = { attachmentKey: 'ATTACH01', pages };
const sel = { kind: 'text', page: 1, rects: [[100, 200, 120, 10], [72, 212, 300, 10]], text: 'A selected sentence', offset: 42 };

test('rects convert between Zotero (bottom-left) and reader (top-left) coordinates, crop origin included', () => {
  const g = { width: 600, height: 800, originX: 10, originY: 20 };
  assert.deepEqual(rectFromZotero(g, [110, 720, 210, 730]), [100, 90, 100, 10]);
  assert.deepEqual(rectToZotero(g, [100, 90, 100, 10]), [110, 720, 210, 730]);
});

test('a reader selection becomes a Zotero highlight with the meaning tag and sort index', () => {
  const p = toZotero(doc, sel, { color: '#2EA8E5', tags: ['AI问答'] });
  assert.equal(p.annotationType, 'highlight');
  assert.equal(p.annotationColor, '#2ea8e5');
  assert.deepEqual(p.tags, [{ tag: 'AI问答' }, { tag: '定义' }]);
  assert.equal(p.annotationSortIndex, '00000|000042|00200');
  assert.deepEqual(JSON.parse(p.annotationPosition), { pageIndex: 0, rects: [[100, 632, 220, 642], [72, 620, 372, 630]] });
  const back = fromZotero({ key: 'K', version: 3, data: p }, pages);
  assert.deepEqual(back.rects, sel.rects);
  assert.equal(back.text, 'A selected sentence');
  const region = toZotero(doc, { kind: 'region', page: 2, rects: [[10, 10, 50, 40]] }, { type: 'underline' });
  assert.equal(region.annotationType, 'image');
  assert.equal(region.annotationText, undefined);
  assert.throws(() => toZotero(doc, { ...sel, rects: [[500, 10, 200, 10]] }));
});

test('changing color swaps only our meaning tag', () => {
  assert.deepEqual(tagsForColor([{ tag: '重点' }, { tag: '方法' }], '#ff6666'), [{ tag: '方法' }, { tag: '存疑' }]);
  assert.deepEqual(tagsForColor([{ tag: '重点' }], '#123456'), []);
});

test('highlights continued on the next page and ink paths are placed', () => {
  const data = { annotationType: 'ink', annotationColor: '#000000', annotationPosition: JSON.stringify({ pageIndex: 0, width: 2, paths: [[10, 832, 20, 822]] }) };
  assert.deepEqual(fromZotero({ key: 'I', data }, pages).paths, [[10, 10, 20, 20]]);
  const two = { annotationType: 'highlight', annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[10, 10, 20, 20]], nextPageRects: [[10, 832, 20, 842]] }) };
  assert.deepEqual(fromZotero({ key: 'H', data: two }, pages).nextRects, [[10, 0, 10, 10]]);
  assert.equal(fromZotero({ key: 'X', data: { annotationPosition: JSON.stringify({ pageIndex: 9, rects: [[1, 1, 2, 2]] }) } }, pages), null);
});

async function setup(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-ann-'));
  const z = await fakeZotero(options);
  const service = new Annotations({ root, fetch: zoteroClient(z.url), backoff: [20, 20, 20, 20, 20] });
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      if (!service.writer.running && !service.writer.ops.some(o => o.status === 'pending')) return;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('queue did not settle');
  };
  try {
    await run({ z, service, settle, root });
  } finally {
    clearTimeout(service.writer.timer);
    await z.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a new highlight is listed at once, written to Zotero, and authorization is asked once', () => setup({}, async ({ z, service, settle }) => {
  const key = await service.create(doc, sel);
  const early = await service.list(doc);
  assert.equal(early.items.find(a => a.key === key)?.text, 'A selected sentence');
  await settle();
  const [stored] = z.annotations();
  assert.equal(stored.key, key);
  assert.equal(stored.data.parentItem, 'ATTACH01');
  assert.deepEqual(stored.data.tags, [{ tag: '重点' }]);
  await service.create(doc, { ...sel, page: 2 });
  await settle();
  assert.equal(z.annotations().length, 2);
  assert.equal(z.state.authorizations, 1);
  const listed = await service.list(doc);
  assert.equal(listed.items.length, 2);
  assert.ok(listed.items.every(a => !a.state));
  assert.deepEqual((await service.list(doc, { since: listed.rev })).unchanged, true);
}));

test('edits change comment, color and tags; delete erases and undo brings it back', () => setup({}, async ({ z, service, settle }) => {
  const key = await service.create(doc, sel);
  await settle();
  await service.update(doc, key, { comment: '问：这是什么？\n答：一个例子。', color: '#a28ae5' });
  await settle();
  let item = z.annotations()[0].data;
  assert.equal(item.annotationComment, '问：这是什么？\n答：一个例子。');
  assert.equal(item.annotationColor, '#a28ae5');
  assert.deepEqual(item.tags, [{ tag: '问答' }]);
  await assert.rejects(service.update(doc, key, { type: 'underline' }), /类型/);
  await service.remove(doc, key);
  assert.equal((await service.list(doc)).items.length, 0);
  await settle();
  assert.equal(z.annotations().length, 0); // erased, as Zotero's own reader does
  assert.equal((await service.list(doc)).items.length, 0);
  const back = await service.undoDelete(doc);
  await settle();
  const [restored] = z.annotations();
  assert.equal(restored.key, back);
  assert.equal(restored.data.annotationComment, '问：这是什么？\n答：一个例子。');
  assert.equal(restored.data.annotationColor, '#a28ae5');
  assert.equal(await service.undoDelete(doc), null);
}));

test('an edit made in Zotero meanwhile is never overwritten', () => setup({}, async ({ z, service, settle }) => {
  const key = await service.create(doc, sel);
  await settle();
  await service.list(doc);
  z.state.offline = true; // hold the write back while someone edits in Zotero
  await service.update(doc, key, { comment: 'mine' });
  await new Promise(r => setTimeout(r, 30));
  z.edit(key, { annotationComment: 'theirs' });
  z.state.offline = false;
  await settle();
  assert.equal(z.annotations()[0].data.annotationComment, 'theirs');
  const listed = await service.list(doc);
  assert.equal(listed.writes[0]?.status, 'conflict');
  await service.writer.discard(listed.writes[0].id);
  assert.equal((await service.list(doc)).writes.length, 0);
}));

test('writes survive Zotero being away, and edits to an unsaved highlight are folded into it', () => setup({}, async ({ z, service, settle }) => {
  z.state.offline = true;
  const key = await service.create(doc, sel);
  await new Promise(r => setTimeout(r, 30));
  await service.update(doc, key, { comment: 'later' });
  assert.equal((await service.list(doc)).items[0].comment, 'later'); // still shown from the queue
  z.state.offline = false;
  z.state.failWrites = 2;
  await settle();
  const all = z.annotations();
  assert.equal(all.length, 1);
  assert.equal(all[0].data.annotationComment, 'later');
}));

test('denied authorization waits for a manual retry; one-time keys ask again', () => setup({ auth: 'deny' }, async ({ z, service, settle }) => {
  await service.create(doc, sel);
  await settle();
  const listed = await service.list(doc);
  assert.equal(listed.writes[0].status, 'failed');
  assert.match(listed.writes[0].error, /拒绝/);
  z.state.auth = 'once';
  await service.writer.retry();
  await settle();
  assert.equal(z.annotations().length, 1);
  await service.create(doc, { ...sel, page: 2 });
  await settle();
  assert.equal(z.annotations().length, 2);
  assert.equal(z.state.authorizations, 3);
}));

test('the queue is kept on disk and resumes in a new process', () => setup({}, async ({ z, root, service }) => {
  z.state.offline = true;
  service.writer.kick = () => {}; // this "process" stops after queuing the write
  await service.create(doc, sel);
  z.state.offline = false;
  const again = new Annotations({ root, fetch: zoteroClient(z.url), backoff: [20] });
  for (let i = 0; i < 500 && z.annotations().length === 0; i++) await new Promise(r => setTimeout(r, 10));
  clearTimeout(again.writer.timer);
  assert.equal(z.annotations().length, 1);
}));

test('an annotation left in the Zotero trash can still be deleted for good', () => setup({}, async ({ z, service, settle }) => {
  const key = await service.create(doc, sel);
  await settle();
  z.edit(key, { deleted: true }); // trashed (in Zotero, or by an older version of this reader)
  assert.equal((await service.list(doc, {})).items.length, 0);
  await service.remove(doc, key);
  await settle();
  assert.equal(z.annotations().length, 0);
  await assert.rejects(service.remove(doc, 'NOSUCH01'), /找不到/);
}));

test('a similar question at the same place replaces its answer; a different one is added', async () => {
  const { mergeQA, similarity } = await import('../src/server/tools.mjs');
  assert.ok(similarity('为什么用 ATOA？', '为什么要用ATOA') >= 0.5);
  assert.ok(similarity('这句话是什么意思？', '作者为什么这样设计？') < 0.5);
  const first = '问：为什么用 ATOA？\n答：限制调整范围（第 7 页）。';
  const again = mergeQA(first, '问：为什么要用ATOA\n答：把调整限制在环形区内（第 7 页）。', '为什么要用ATOA');
  assert.equal(again, '问：为什么要用ATOA\n答：把调整限制在环形区内（第 7 页）。');
  const added = mergeQA(again, '问：外圆半径怎么定？\n答：R = γr（第 7 页）。', '外圆半径怎么定？');
  assert.equal(added.split('\n\n').length, 2);
});
