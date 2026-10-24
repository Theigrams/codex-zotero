// Removes the plugin from Codex (INSTALL.md, "卸载").
//   node uninstall.mjs          plugin and its marketplace
//   node uninstall.mjs --all    also the reader's state (tabs, positions, settings, write queue) and page cache
// Fonts stay: other apps may use them. The script lists them for removal by hand.
import { execFileSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MARKET, PLUGIN } from './build.mjs';

const CODEX = process.env.CODEX_ZOTERO_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const run = args => {
  try {
    execFileSync(CODEX, args, { stdio: 'inherit' });
  } catch {
    console.log(`(codex ${args.join(' ')} failed; it may already be removed)`);
  }
};

run(['plugin', 'remove', `${PLUGIN}@${MARKET}`]);
run(['plugin', 'marketplace', 'remove', MARKET]);
const state = process.env.CODEX_ZOTERO_STATE || join(homedir(), '.codex', 'codex-zotero');
const cache = process.env.CODEX_ZOTERO_CACHE || join(homedir(), 'Library', 'Caches', 'codex-zotero');
if (process.argv.includes('--all')) {
  for (const dir of [state, cache]) await rm(dir, { recursive: true, force: true });
  console.log(`removed ${state} and ${cache}`);
} else {
  console.log(`kept the reader's state (${state}) and cache (${cache}); "node uninstall.mjs --all" removes them`);
}
const fonts = join(homedir(), 'Library', 'Fonts');
const ours = (await readdir(fonts).catch(() => [])).filter(f => /^KaTeX_.*\.ttf$|^Lora(-Italic)?\[wght\]\.ttf$/.test(f));
if (ours.length) console.log(`fonts installed for the reader, remove by hand if unused elsewhere:\n${ours.map(f => `  ${join(fonts, f)}`).join('\n')}`);
console.log('Restart Codex (⌘Q) to unload the plugin.');
