// Prompt in the terminal; never put the key in command arguments, project files, or logs.
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
if (!stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
stdout.write('MinerU API key (hidden): ');
readline.emitKeypressEvents(stdin); stdin.setRawMode(true);
let key = '';
await new Promise(resolve => stdin.on('keypress', (s, k) => {
  if (k?.ctrl && k.name === 'c') process.exit(1);
  else if (k?.name === 'return') resolve();
  else if (k?.name === 'backspace') key = key.slice(0, -1);
  else if (s) key += s;
}));
stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
if (!key.trim() || /\s/.test(key.trim())) throw new Error('Invalid key');
const dir = join(homedir(), '.codex', 'codex-zotero');
await mkdir(dir, { recursive: true });
const file = join(dir, 'mineru-secret.json');
await writeFile(file, JSON.stringify({ apiKey: key.trim() }), { mode: 0o600 });
await chmod(file, 0o600);
console.log('MinerU configured. The key is stored outside the repository.');
