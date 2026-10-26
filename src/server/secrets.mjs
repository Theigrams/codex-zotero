// API keys (official and self-hosted MinerU) in the macOS keychain, through /usr/bin/security: items it creates are
// readable by it again without an authorization prompt. Never returned to the panel or the model, only "set or not".
// CODEX_ZOTERO_SECRETS=<file> keeps them in a JSON file (mode 0600) instead, for tests and the preflight.
import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { atomicJSON, jsonFile } from './files.mjs';

const SERVICE = 'codex-zotero';
export const SECRET_NAMES = ['mineru', 'mineru-self'];

const security = args => new Promise((resolve, reject) => {
  execFile('/usr/bin/security', args, { timeout: 5000 }, (e, out) => (e ? reject(e) : resolve(out.trim())));
});

export class Secrets {
  constructor(file = process.env.CODEX_ZOTERO_SECRETS || '') {
    this.file = file;
  }

  check(name) {
    if (!SECRET_NAMES.includes(name)) throw new Error('未知的密钥。');
  }

  async get(name) {
    this.check(name);
    if (this.file) return (await jsonFile(this.file, {}))[name] || '';
    return security(['find-generic-password', '-s', SERVICE, '-a', name, '-w']).catch(() => '');
  }

  // An empty value removes the key.
  async set(name, value) {
    this.check(name);
    const v = String(value || '').trim();
    if (v.length > 4096 || /\s/.test(v)) throw new Error('Key 不能包含空白字符。');
    if (this.file) {
      const all = await jsonFile(this.file, {});
      if (v) all[name] = v;
      else delete all[name];
      await atomicJSON(this.file, all);
      await chmod(this.file, 0o600);
      return;
    }
    if (v) await security(['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', v]);
    else await security(['delete-generic-password', '-s', SERVICE, '-a', name]).catch(() => {});
  }

  async which() {
    return Object.fromEntries(await Promise.all(SECRET_NAMES.map(async n => [n, !!(await this.get(n))])));
  }
}
