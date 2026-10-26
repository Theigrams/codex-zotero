// Installs the local-only detector. No PDF, credential, or document content is uploaded here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
const runtime = join(homedir(), '.codex', 'codex-zotero-runtime');
const python = process.env.CODEX_ZOTERO_PYTHON || join(runtime, 'bin', 'python');
if (!process.env.CODEX_ZOTERO_PYTHON) execFileSync('python3', ['-m', 'venv', runtime], { stdio: 'inherit' });
execFileSync(python, ['-m', 'pip', 'install', '-r', 'native/requirements-analysis.txt'], { stdio: 'inherit' });
const dir = join(homedir(), '.cache', 'codex-zotero', 'models');
const file = join(dir, 'pp-doclayout-v2.onnx');
const hash = 'cd540dc296ff3115fe78efa65b68501e6a8dc74b198acc9834a725ffaa095aac';
const valid = async () => createHash('sha256').update(await readFile(file).catch(() => '')).digest('hex') === hash;
await mkdir(dir, { recursive: true });
if (!(await valid())) {
  const url = 'https://huggingface.co/opendatalab/MinerU-4_models_onnx/resolve/358310b4f64b95f9fefc372ad899356e4111f376/Layout/PP-DocLayoutV2/inference.onnx';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Model checksum mismatch');
  await writeFile(file + '.download', bytes);
  await rename(file + '.download', file);
}
console.log(`Local layout ready. Python: ${python}\nModel: ${file}\nRun npm run install-plugin next.`);
