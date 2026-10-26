import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Paper } from '../src/server/paper.mjs';
import { FAKE_CONTENT, FAKE_STRUCTURED, fakeMinerU } from './fake-mineru.mjs';

// The official API address is read when the module loads; point it at a fake in the official form.
const official = await fakeMinerU({ official: true, key: 'official-key' });
process.env.CODEX_ZOTERO_MINERU_API = official.url;
const { Recognition, buildIndex, equations, fromStructured, withRecognized } = await import('../src/server/recognition.mjs');
const { PaperMaps } = await import('../src/server/map.mjs'); // imports recognition.mjs: after the address is set

test.after(() => official.close());

const pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }];

async function setup(keys, recognition, fn) {
  const root = await mkdtemp(join(tmpdir(), 'codex-zotero-rec-'));
  const path = join(root, 'paper.pdf');
  await writeFile(path, '%PDF-1.4 test');
  const doc = { id: 'abcdef0123456789', fingerprint: 'f'.repeat(64), path, pageCount: 2, pages };
  const r = new Recognition({ root, secrets: { get: async n => keys[n] || '' }, settings: async () => ({ recognition }), poll: 5 });
  try {
    await fn({ r, doc, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Generous: other test files (and the build in mcp.test.mjs) run at the same time.
const settled = async (r, doc) => {
  for (const end = Date.now() + 20000; Date.now() < end;) {
    const s = await r.status(doc);
    if (s.state === 'done' || s.state === 'failed') return s;
    await new Promise(res => setTimeout(res, 10));
  }
  return r.status(doc);
};

test('the content list becomes per-page text and blocks in page points', () => {
  const [p1] = buildIndex(FAKE_CONTENT, pages);
  assert.ok(!p1.text.includes('Journal header'), 'running headers are left out of the text');
  assert.match(p1.text, /^## Recognized title/);
  assert.match(p1.text, /\$\$\n\\Phi\^\*\(u\)/);
  assert.match(p1.text, /Table 1 Limits\nA \| 2\nC \| 5/);
  const eq = p1.blocks.find(b => b.labels?.includes('12'));
  assert.deepEqual(eq.rect, [312, 240, 72, 32]);
  assert.deepEqual(equations({ pages: buildIndex(FAKE_CONTENT, pages) }).map(e => e.label), ['12', '7a', '7b']);
  // For the debug view: the table as Markdown, captions and image paths.
  assert.equal(p1.blocks.find(b => b.type === 'table').table, '| A | 2 |\n| --- | --- |\n| C | 5 |');
  assert.deepEqual(p1.blocks.filter(b => b.type === 'chart').map(b => [b.caption, b.img]), [['(a)', 'images/a.jpg'], ['(b) Fig. 1. Two views of the setup.', 'images/b.jpg']]);
  // MinerU sometimes tags a formula with something that is no number.
  const [junk] = buildIndex([{ type: 'equation', text: '$$\nx \\tag{. . . .}\n$$', bbox: [0, 0, 10, 10], page_idx: 0 }], pages);
  assert.equal(junk.blocks[0].labels, undefined);
});

test('the figure index comes from the recognized figure: all its parts, where the layout guess had only the caption line', () => {
  const index = { pages: buildIndex(fromStructured(FAKE_STRUCTURED), pages) };
  const chart = index.pages[0].blocks.find(b => b.caption?.includes('Fig. 1'));
  assert.deepEqual(chart.captionRect, [180, 688, 240, 16], 'the self-hosted service gives caption boxes (not of the letters)');
  const guessed = { sections: [], equations: [], captions: [{ kind: '图', label: '1', page: 1, y: 690, x: 300, text: 'Two views' }, { kind: '图', label: '2', page: 2, y: 100, x: 300, text: 'Kept' }] };
  const o = withRecognized(guessed, index);
  assert.deepEqual(o.captions.map(c => [c.kind, c.label, c.page, c.y, c.rect]), [
    ['表', '1', 1, 400, [60, 400, 480, 80]], ['图', '1', 1, 520, [60, 520, 480, 184]], ['图', '2', 2, 100, undefined]]);
  assert.equal(o.captions[1].text, 'Two views of the setup.');
});

test('the self-hosted structured content gives the same index', () => {
  const [p1] = buildIndex(fromStructured(FAKE_STRUCTURED), pages);
  assert.ok(!p1.text.includes('Journal header'));
  assert.match(p1.text, /^## Recognized title/);
  assert.match(p1.text, /Table 1 Limits\n\| A \| 2 \|/);
  assert.deepEqual(p1.blocks.find(b => b.labels?.includes('12')).rect, [312, 240, 72, 32]);
});

test('official: upload to storage without the key, keep the ZIP without the PDF copy, and reading uses it', () => setup({ mineru: 'official-key' }, {}, async ({ r, doc, root }) => {
  assert.equal((await r.status(doc)).state, 'none');
  await r.start(doc);
  const s = await settled(r, doc);
  assert.equal(s.state, 'done', s.error);
  assert.equal(s.backend, 'official');
  assert.equal(String(official.uploaded()), '%PDF-1.4 test');
  assert.ok(!official.log.some(l => l.includes('WITH KEY')), 'the key never goes to another origin');
  const zip = join(root, 'recognition', doc.id, 'mineru.zip');
  const names = execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, ['full.md', 'x_content_list.json']);
  assert.equal(((await stat(zip)).mode & 0o777).toString(8), '600');
  const read = await new Paper({ page: (d, k) => ({ t: [`glyphs of page ${k}`] }) }, { enhanced: d => r.load(d) }).read(doc, 1, 2);
  assert.equal(read[0].source, 'mineru');
  assert.match(read[0].text, /Recognized paragraph/);
  assert.deepEqual([read[1].source, read[1].text], [undefined, 'glyphs of page 2'], 'a page left empty falls back to the glyph layer');
  // A second request does nothing: one recognition per paper.
  assert.equal((await r.start(doc)).state, 'done');
  // A new process finds the stored result.
  const again = new Recognition({ root, secrets: { get: async () => '' }, settings: async () => ({}) });
  assert.equal((await again.status(doc)).state, 'done');
}));

test('official: a file MinerU already has is not uploaded again', () => setup({ mineru: 'official-key' }, {}, async ({ r, doc }) => {
  const puts = official.puts();
  await r.start(doc);
  assert.equal((await settled(r, doc)).state, 'done');
  assert.equal(official.puts(), puts);
}));

test('self-hosted: same-origin upload with the key, structured content, and an anonymous service needs no key', async () => {
  const self = await fakeMinerU({ key: 'self-key' });
  const anonymous = await fakeMinerU({ key: '' });
  try {
    await setup({ mineru: 'official-key', 'mineru-self': 'self-key' }, { selfUrl: `${self.url}v1` }, async ({ r, doc, root }) => {
      await r.start(doc);
      const s = await settled(r, doc);
      assert.equal(s.backend, 'self', s.error);
      assert.equal(self.puts(), 1);
      const names = execFileSync('/usr/bin/unzip', ['-Z1', join(root, 'recognition', doc.id, 'mineru.zip')], { encoding: 'utf8' });
      assert.match(names, /structured_content\.json/);
      assert.match((await r.load(doc)).pages[0].text, /Recognized paragraph/);
    });
    await setup({}, { selfUrl: anonymous.url }, async ({ r, doc }) => {
      await r.start(doc);
      assert.equal((await settled(r, doc)).backend, 'self');
    });
  } finally {
    self.close();
    anonymous.close();
  }
});

test('an index from an older version is built again from the kept ZIP, without asking MinerU', () => setup({ mineru: 'official-key' }, {}, async ({ r, doc, root }) => {
  await r.start(doc);
  assert.equal((await settled(r, doc)).state, 'done');
  const file = join(root, 'recognition', doc.id, 'index.json');
  const old = JSON.parse(await readFile(file, 'utf8'));
  for (const p of old.pages) for (const b of p.blocks) delete b.caption;
  await writeFile(file, JSON.stringify({ ...old, version: 1 }));
  const calls = official.log.length;
  const again = new Recognition({ root, secrets: { get: async () => '' }, settings: async () => ({}) });
  const blocks = await again.page(doc, 1);
  assert.ok(blocks.some(b => b.caption?.includes('Fig. 1')));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2, 'written back');
  assert.equal(official.log.length, calls);
  assert.equal(await again.page(doc, 2).then(b => b.length), 0);
}));

test('without a key or a self-hosted service nothing is sent', () => setup({}, {}, async ({ r, doc }) => {
  await assert.rejects(r.start(doc), /Key/);
}));

test('a refused key and a failed parse end as failed with the reason', async () => {
  await setup({ mineru: 'wrong' }, {}, async ({ r, doc }) => {
    await r.start(doc);
    assert.match((await settled(r, doc)).error, /Key 无效/);
  });
  const broken = await fakeMinerU({ key: 'k', fail: true });
  try {
    await setup({ 'mineru-self': 'k' }, { selfUrl: broken.url }, async ({ r, doc }) => {
      await r.start(doc);
      assert.match((await settled(r, doc)).error, /^自部署 MinerU：MinerU 识别失败：file damaged/);
    });
  } finally {
    broken.close();
  }
});

test('the official service is used after the self-hosted one only when the user allowed falling back', async () => {
  const down = 'http://127.0.0.1:9/';
  await setup({ mineru: 'official-key', 'mineru-self': 'x' }, { selfUrl: down }, async ({ r, doc }) => {
    await r.start(doc);
    const s = await settled(r, doc);
    assert.equal(s.state, 'failed', 'no fallback by default: the paper stays with the self-hosted service');
    assert.equal(s.error, '自部署 MinerU：网络错误，请检查网络后重试。');
  });
  await setup({ mineru: 'official-key', 'mineru-self': 'x' }, { selfUrl: down, fallback: true }, async ({ r, doc }) => {
    await r.start(doc);
    const s = await settled(r, doc);
    assert.equal(s.state, 'done', s.error);
    assert.equal(s.backend, 'official');
  });
});

test('two clicks start one recognition; an empty result fails', async () => {
  const counted = await fakeMinerU({ key: 'k', polls: 3 });
  try {
    await setup({ 'mineru-self': 'k' }, { selfUrl: counted.url }, async ({ r, doc }) => {
      await Promise.all([r.start(doc), r.start(doc)]);
      assert.equal((await settled(r, doc)).state, 'done');
      assert.equal(counted.puts(), 1);
    });
  } finally {
    counted.close();
  }
  const empty = await fakeMinerU({ key: 'k', structured: { pages: [{ page_idx: 0, blocks: [{ type: 'header', bbox: [0, 0, 1, 1], content: '' }] }] } });
  try {
    await setup({ 'mineru-self': 'k' }, { selfUrl: empty.url }, async ({ r, doc }) => {
      await r.start(doc);
      assert.match((await settled(r, doc)).error, /没有文字/);
    });
  } finally {
    empty.close();
  }
});

test('the connection test asks for a job that does not exist: it checks the key and uploads nothing', async () => {
  const self = await fakeMinerU({ key: 'self-key' });
  const anonymous = await fakeMinerU({ key: '' });
  try {
    await setup({ mineru: 'official-key' }, { selfUrl: self.url }, async ({ r }) => {
      assert.deepEqual(await r.test({ backend: 'official' }), { ok: true, message: '连接正常，Key 有效。' });
      assert.match((await r.test({ backend: 'official', key: 'typed-but-wrong' })).message, /Key 无效/);
      assert.equal((await r.test({ backend: 'self' })).message, '这个服务需要 Key。');
      assert.equal((await r.test({ backend: 'self', key: 'self-key' })).ok, true);
      assert.equal((await r.test({ backend: 'self', url: anonymous.url })).message, '连接正常，服务不需要 Key。');
      assert.match((await r.test({ backend: 'self', url: 'http://127.0.0.1:9' })).message, /^无法连接/);
      assert.match((await r.test({ backend: 'self', url: 'http://example.org' })).message, /^地址无效/);
    });
    await setup({}, {}, async ({ r }) => {
      assert.equal((await r.test({ backend: 'official' })).message, '还没有填写 MinerU Key。');
      assert.equal((await r.test({ backend: 'self' })).message, '还没有填写自部署 MinerU 的地址。');
    });
    assert.ok(![...self.log, ...anonymous.log].some(l => /uploads|PUT/.test(l)), 'nothing uploaded');
  } finally {
    self.close();
    anonymous.close();
  }
});

test('the paper map waits for a recognition under way and is built on its text and equations', async () => {
  const slow = await fakeMinerU({ key: 'k', polls: 3 });
  try {
    await setup({ 'mineru-self': 'k' }, { selfUrl: slow.url }, async ({ r, doc, root }) => {
      Object.assign(doc, { itemKey: 'ITEM0001', attachmentKey: 'ATTACH01', title: 'T', cacheDir: root });
      const paper = new Paper({ page: (d, k) => ({ t: [`glyphs of page ${k}`], l: [0], b: [10, 10, 100, 10] }) }, { enhanced: d => r.load(d) });
      let input = '', html = '';
      const run = async text => {
        input = text;
        return { text: `## 一句话\n${'内容'.repeat(120)}\n## 问题与贡献\n## 结构\n## 核心概念与符号\n见式 (12) 与图 1。[p.1]`, threadId: null };
      };
      class Maps extends PaperMaps {
        async find() { return null; } // no Zotero here
      }
      const maps = new Maps({ writer: { writeNote: async n => { html = n.html; return 'NOTE0001'; } }, paper, pool: { run: async () => ({}) }, recognition: r, run });
      await r.start(doc);
      maps.start(doc);
      await maps.jobs.get(doc.id).done;
      assert.equal(maps.status(doc).status, 'done', maps.status(doc).error);
      assert.match(input, /【全文（逐页，来自增强识别/);
      assert.match(input, /=== 第 1 页 ===\n## Recognized title/);
      assert.match(input, /=== 第 2 页 ===\nglyphs of page 2/, 'a page the recognition left empty keeps the glyph text');
      assert.match(input, /\(12\) 第 1 页/, 'the structure index lists the recognized equations');
      assert.match(html, /k=eq/, 'the map links 式 (12) to the recognized box');
      assert.match(html, /page=1&amp;y=520&amp;x=300&amp;k=fig/, 'and 图 1 to the top of the whole figure');
      assert.match(html, /page=1&amp;y=240&amp;x=348&amp;k=eq/);
      assert.match(input, /图 1（第 1 页）Two views of the setup\./, 'figures recognized, though the glyph layer has no caption');
    });
  } finally {
    slow.close();
  }
});
