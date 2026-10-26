// Rules that span several files and that nothing else enforces. Each one has broken before or is easy to
// break without noticing; a failure names the file to fix. Runs with `npm test`, or alone with `npm run check`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const read = file => readFileSync(join(root, file), 'utf8');

// Tracked files (a new file counts once it is git-added), or every file outside .git / node_modules / out
// when this is not a git checkout (the exported public copy before its first commit).
function files() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(f => f && existsSync(join(root, f)));
  } catch {
    return readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
      .map(e => relative(root, join(e.parentPath ?? e.path, e.name)))
      .filter(f => !/^(\.git|node_modules|out)\//.test(f));
  }
}

// Standard-library modules the native helpers may import. A new stdlib import fails the check once;
// add it here rather than to requirements.txt.
const STDLIB = new Set(['io', 'json', 'math', 'sys', 'os', 're', 'unicodedata', 'struct', 'zlib', 'base64', 'time',
  'collections', 'itertools', 'functools', 'pathlib', 'hashlib', 'traceback']);
// Import name → name in requirements.txt, where they differ.
const DIST = { fitz: 'pymupdf', fontTools: 'fonttools', PIL: 'pillow' };

const requirements = () => read('native/requirements.txt').split('\n')
  .map(l => l.replace(/#.*/, '').trim().split(/[<>=!~\s[]/)[0].toLowerCase()).filter(Boolean);

test('every third-party module the native helpers import is in native/requirements.txt', () => {
  const py = readdirSync(join(root, 'native')).filter(f => f.endsWith('.py'));
  const local = new Set(py.map(f => f.slice(0, -3)));
  const reqs = new Set(requirements());
  const missing = [];
  for (const f of py) {
    for (const line of read(`native/${f}`).split('\n')) {
      const m = line.match(/^\s*(?:import\s+([\w., ]+?)(?:\s+as\s+\w+)?\s*(?:#.*)?$|from\s+(\w+)[\w.]*\s+import\b)/);
      if (!m) continue;
      const names = m[2] ? [m[2]] : m[1].split(',').map(s => s.trim().split(/\s+as\s+|\./)[0]);
      for (const name of names) {
        if (local.has(name) || STDLIB.has(name)) continue;
        if (!reqs.has((DIST[name] ?? name).toLowerCase())) missing.push(`native/${f}: ${name}`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'add these to native/requirements.txt (or to STDLIB in this test)');
});

test('install.mjs checks for every Python requirement before turning text repair on', () => {
  const probe = read('install.mjs').match(/'-c',\s*'([^']*)'/)?.[1] ?? '';
  const imported = new Set(probe.match(/^\s*import\s+([^;]+)/)?.[1].split(',').map(s => s.trim().toLowerCase()) ?? []);
  const byDist = Object.fromEntries(Object.entries(DIST).map(([mod, dist]) => [dist, mod.toLowerCase()]));
  const unchecked = requirements().filter(r => !imported.has(r) && !imported.has(byDist[r]));
  assert.deepEqual(unchecked, [], `install.mjs findPython() imports "${probe}"`);
});

test('what the plugin bundles is a dependency, and every dependency is used', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const dev = Object.keys(pkg.devDependencies ?? {});
  const bare = file => [...read(file).matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'|^\s*import\s+'([^']+)'/gm)]
    .map(m => m[1] ?? m[2] ?? m[3]).filter(s => /^(@[\w.-]+\/)?\w[\w.-]*(\/|$)/.test(s) && !s.startsWith('node:'))
    .map(s => s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
  const all = files().filter(f => /\.m?js$/.test(f));
  const bundled = new Set(all.filter(f => f.startsWith('src/') && !f.startsWith('src/dev/')).flatMap(bare));
  const used = new Set(all.flatMap(bare));
  assert.deepEqual([...bundled].filter(p => !deps.includes(p)), [], 'imported by src/ but not in dependencies');
  assert.deepEqual([...deps, ...dev].filter(p => !used.has(p)), [], 'in package.json but imported nowhere');
});

test('no personal or generated files are tracked', () => {
  const bad = files().filter(f => /\.(pdf|onnx|zip)$|(^|\/)(zotero-auth|writes|tabs|notes|preferences)\.json$|^(out|node_modules)\//.test(f));
  assert.deepEqual(bad, []);
});

// Markdown files describe what exists. Proposals and plans are not mixed into them (proposal files and
// acceptance checklists are plans by nature and are exempt).
test('documents carry no proposal or draft markers', () => {
  const hits = [];
  for (const f of files().filter(f => f.endsWith('.md') && !/(^|\/)(acceptance|proposals)\//.test(f))) {
    read(f).split('\n').forEach((line, i) => {
      if (/【(提议|草案)/.test(line) || /^#+ .*(草案|编码前|待实现)/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('relative links in Markdown point at files that exist', () => {
  const broken = [];
  for (const f of files().filter(f => f.endsWith('.md'))) {
    // public/ is laid over the repository root when exported, so its links may point either way.
    const bases = f.startsWith('public/') ? [dirname(f), dirname(relative('public', f))] : [dirname(f)];
    for (const [, target] of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:|^#/i.test(target)) continue;
      const path = decodeURI(target.split('#')[0]);
      if (!bases.some(b => existsSync(join(root, b, path)))) broken.push(`${f}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
