import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State, moveState, stateDir, supportDir } from '../src/server/state.mjs';
import { resolvePdf } from '../src/server/zotero.mjs';

async function withState(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-state-'));
  try {
    await run(new State(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const doc = (id, title = 'Paper') => ({ id, path: `/papers/${id}.pdf`, title, itemKey: 'ITEMKEY1', attachmentKey: 'ATTKEY01' });

test('preferences default to aligned and reject unknown modes', () => withState(async state => {
  assert.equal((await state.prefs()).renderMode, 'aligned');
  assert.equal((await state.setPrefs({ renderMode: 'rounded' })).renderMode, 'rounded');
  assert.equal((await state.prefs()).renderMode, 'rounded');
  await assert.rejects(state.setPrefs({ renderMode: 'blur' }));
}));

test('position is clamped, kept per document and survives a new State', () => withState(async (state, root) => {
  await state.touch(doc('0123456789abcdef'));
  await state.savePosition('0123456789abcdef', { page: 10.7, offset: 1.4, zoom: 9 });
  const again = new State(root);
  assert.deepEqual((await again.document('0123456789abcdef')).position, { page: 10, offset: 1, zoom: 4 });
  await assert.rejects(state.savePosition('ffffffffffffffff', { page: 1, offset: 0, zoom: 1 }));
}));

test('recent lists newest first and skips corrupt records', () => withState(async (state, root) => {
  await state.touch(doc('aaaaaaaaaaaaaaaa', 'Old'), 1000);
  await state.touch(doc('bbbbbbbbbbbbbbbb', 'New'), 2000);
  await mkdir(join(root, 'documents'), { recursive: true });
  await writeFile(join(root, 'documents', 'cccccccccccccccc.json'), '{not json');
  assert.deepEqual((await state.recent()).map(r => r.title), ['New', 'Old']);
}));

test('touch keeps keys learned earlier when reopened by path', () => withState(async state => {
  await state.touch(doc('aaaaaaaaaaaaaaaa'));
  await state.touch({ id: 'aaaaaaaaaaaaaaaa', path: '/papers/a.pdf', title: 'Paper', itemKey: null, attachmentKey: null });
  assert.equal((await state.document('aaaaaaaaaaaaaaaa')).itemKey, 'ITEMKEY1');
}));

test('resolvePdf maps a child attachment key back to its paper', async () => {
  const items = {
    'items/ATTKEY01': { key: 'ATTKEY01', data: { itemType: 'attachment', parentItem: 'ITEMKEY1', contentType: 'application/pdf' } },
    'items/ITEMKEY1': { key: 'ITEMKEY1', data: { itemType: 'journalArticle', title: 'A paper' } },
    'items/ITEMKEY1/children': [
      { key: 'ATTKEY01', data: { itemType: 'attachment', contentType: 'application/pdf' } },
      { key: 'NOTE0001', data: { itemType: 'note' } },
    ],
    'items/ATTKEY01/file/view/url': `"file://${new URL(import.meta.url).pathname}"`,
  };
  const read = async route => items[route];
  const r = await resolvePdf({ itemKey: 'ATTKEY01' }, read);
  assert.equal(r.itemKey, 'ITEMKEY1');
  assert.equal(r.attachmentKey, 'ATTKEY01');
  assert.equal(r.title, 'A paper');
  await assert.rejects(resolvePdf({ itemKey: 'bad' }, read));
});

test('tabs open after the active one, close to the right neighbor, and persist', () => withState(async (state, root) => {
  const [a, b, c] = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
  await state.openTab(a);
  await state.openTab(b);
  await state.openTab(a);
  assert.deepEqual(await state.openTab(c), { tabs: [a, c, b], active: c });
  assert.deepEqual(await state.closeTab(c), { tabs: [a, b], active: b });
  assert.deepEqual(await new State(root).tabs(), { tabs: [a, b], active: b });
  await state.closeTab(b);
  assert.deepEqual(await state.closeTab(a), { tabs: [], active: null });
}));

test('the state moves out of ~/.codex once, as a whole, and never over a newer one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-move-'));
  const { readFile, stat } = await import('node:fs/promises');
  try {
    const old = join(root, '.codex', 'codex-zotero');
    const to = join(root, 'Application Support', 'codex-zotero', 'state');
    assert.equal(await moveState(old, to), false, 'nothing to move');
    await mkdir(join(old, 'documents'), { recursive: true });
    await writeFile(join(old, 'preferences.json'), '{"mapPrompt":"mine"}', { mode: 0o600 });
    await writeFile(join(old, 'documents', 'abc.json'), '{"position":{"page":8}}');
    assert.equal(await moveState(old, to), true);
    assert.equal(JSON.parse(await readFile(join(to, 'preferences.json'), 'utf8')).mapPrompt, 'mine');
    assert.equal((await stat(join(to, 'preferences.json'))).mode & 0o777, 0o600, 'permissions kept');
    assert.ok(await readFile(join(to, 'documents', 'abc.json'), 'utf8'));
    await assert.rejects(stat(old), 'the old folder is gone');
    // An old Codex process still running writes the old folder again: the moved state is not touched.
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'preferences.json'), '{"mapPrompt":"stale"}');
    assert.equal(await moveState(old, to), false);
    assert.equal(JSON.parse(await readFile(join(to, 'preferences.json'), 'utf8')).mapPrompt, 'mine');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state and support folders: Application Support by default, the environment can move them', () => {
  const home = process.env.HOME;
  assert.equal(supportDir({}), join(home, 'Library', 'Application Support', 'codex-zotero'));
  assert.equal(stateDir({}), join(home, 'Library', 'Application Support', 'codex-zotero', 'state'));
  assert.equal(stateDir({ CODEX_ZOTERO_SUPPORT: '/x' }), '/x/state');
  assert.equal(stateDir({ CODEX_ZOTERO_SUPPORT: '/x', CODEX_ZOTERO_STATE: '/y' }), '/y');
});
