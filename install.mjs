// Builds and installs the plugin into Codex as a local plugin (INSTALL.md).
//   node install.mjs            (or npm run install-plugin)
// First run registers the marketplace and adds the plugin; later runs refresh the installed files.
// Codex loads a new server only after a restart (⌘Q); panel-only changes apply when the panel reopens.
// The Python used for PyMuPDF's glyph repair is CODEX_ZOTERO_PYTHON, else the python3 on this shell's PATH;
// its absolute path goes into the plugin's launch config, since Codex starts servers with another PATH.
// It also installs the fonts notes and formulas are set in, for this user (~/Library/Fonts): the panel's
// sandbox blocks font files, so the panel uses installed fonts by name — KaTeX's 20 fonts (formulas, as in
// Zotero) and Lora (Latin text in notes; SIL OFL, fonts/). Remove KaTeX_*.ttf and Lora*.ttf there to undo.
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildPlugin, INSTALLED, MARKET, PLUGIN } from './build.mjs';

const CODEX = process.env.CODEX_ZOTERO_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

const FONT_DIR = join(homedir(), 'Library', 'Fonts');
async function installFonts() {
  await mkdir(FONT_DIR, { recursive: true });
  const katex = 'node_modules/katex/dist/fonts';
  const files = [...(await readdir(katex)).filter(f => f.endsWith('.ttf')).map(f => join(katex, f)), 'fonts/Lora[wght].ttf', 'fonts/Lora-Italic[wght].ttf'];
  let added = 0;
  for (const f of files) {
    const to = join(FONT_DIR, basename(f));
    try {
      await stat(to);
    } catch {
      await copyFile(f, to);
      added++;
    }
  }
  console.log(added ? `installed ${added} fonts into ~/Library/Fonts (restart Codex to use them)` : `fonts present in ~/Library/Fonts (${files.length})`);
}

// The absolute path of a Python that can import PyMuPDF, or '' (the plugin then runs without glyph repair).
function findPython() {
  const local = join(homedir(), '.codex', 'codex-zotero-runtime', 'bin', 'python');
  let candidate = process.env.CODEX_ZOTERO_PYTHON || local;
  try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); } catch { candidate = 'python3'; }
  try {
    const path = execFileSync(candidate, ['-c', 'import sys, pymupdf, fontTools; print(sys.executable)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    console.log(`PyMuPDF found: ${path}`);
    return path;
  } catch {
    console.log(`PyMuPDF not found for ${candidate}: text repair is off. Install it with "${candidate} -m pip install pymupdf fonttools" and run this again,`
      + ' or set CODEX_ZOTERO_PYTHON to a Python that has it.');
    return '';
  }
}

await buildPlugin({ python: findPython() });
await installFonts();
let installed = false;
try {
  await stat(INSTALLED);
  installed = true;
} catch {}

if (installed) {
  await cp('out/plugin', INSTALLED, { recursive: true, force: true });
  console.log(`updated ${INSTALLED}`);
} else {
  execFileSync(CODEX, ['plugin', 'marketplace', 'add', resolve('out')], { stdio: 'inherit' });
  execFileSync(CODEX, ['plugin', 'add', `${PLUGIN}@${MARKET}`], { stdio: 'inherit' });
}
console.log('Restart Codex (⌘Q) if the server changed.');
