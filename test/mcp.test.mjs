// The panel's tools as the host calls them: over MCP, where a tool without an input schema gets no arguments.
// (The preflight calls them over the standalone server's HTTP route, which passes arguments either way.)
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeMinerU } from './fake-mineru.mjs';

const root = new URL('..', import.meta.url).pathname;

test('panel tools get their arguments over MCP', async () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'ignore' }); // the server as installed, with its helper
  const dir = await mkdtemp(join(tmpdir(), 'codex-zotero-mcp-'));
  const mineru = await fakeMinerU({ official: true, key: 'good-key' });
  const client = new Client({ name: 'test', version: '0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [join(root, 'out/plugin/dist/server.mjs')], stderr: 'ignore',
      env: { ...process.env, CODEX_ZOTERO_STATE: join(dir, 'state'), CODEX_ZOTERO_CACHE: join(dir, 'cache'), CODEX_ZOTERO_SUPPORT: join(dir, 'support'),
        CODEX_ZOTERO_SECRETS: join(dir, 'secrets.json'), CODEX_ZOTERO_MINERU_API: mineru.url, CODEX_ZOTERO_API: 'http://127.0.0.1:9/' },
    }));
    const tools = (await client.listTools()).tools;
    const test = tools.find(t => t.name === 'recognition_test');
    assert.ok(test?.inputSchema?.properties?.backend, 'recognition_test declares its arguments');
    const call = async args => (await client.callTool({ name: 'recognition_test', arguments: args })).structuredContent;
    assert.deepEqual(await call({ backend: 'official', key: 'good-key' }), { ok: true, message: '连接正常，Key 有效。' });
    assert.match((await call({ backend: 'official', key: 'wrong' })).message, /Key 无效/);
  } finally {
    await client.close().catch(() => {});
    mineru.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the installed server moves the state out of ~/.codex on its first start', async () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'ignore' });
  const home = await mkdtemp(join(tmpdir(), 'codex-zotero-home-'));
  const { mkdir, readFile, stat, writeFile } = await import('node:fs/promises');
  const client = new Client({ name: 'test', version: '0' });
  try {
    await mkdir(join(home, '.codex', 'codex-zotero'), { recursive: true });
    await writeFile(join(home, '.codex', 'codex-zotero', 'preferences.json'), '{"mapPrompt":"mine"}');
    const env = { ...process.env, HOME: home, CODEX_ZOTERO_CACHE: join(home, 'cache'), CODEX_ZOTERO_API: 'http://127.0.0.1:9/' };
    delete env.CODEX_ZOTERO_STATE;
    delete env.CODEX_ZOTERO_SUPPORT;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'out/plugin/dist/server.mjs')], stderr: 'ignore', env }));
    const moved = join(home, 'Library', 'Application Support', 'codex-zotero', 'state', 'preferences.json');
    assert.equal(JSON.parse(await readFile(moved, 'utf8')).mapPrompt, 'mine');
    await assert.rejects(stat(join(home, '.codex', 'codex-zotero')));
  } finally {
    await client.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});
