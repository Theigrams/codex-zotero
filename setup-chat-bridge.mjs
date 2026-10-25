// Explicit local opt-in. Secrets belong to tunnel-client's environment, never this file.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicJSON, jsonFile } from './src/server/files.mjs';
const root=process.env.CODEX_ZOTERO_STATE || join(homedir(),'.codex','codex-zotero');
const file=join(root,'chat-bridge-enabled.json');
const command=process.argv[2] || 'status';
if(!['enable','disable','status'].includes(command))throw new Error('Usage: node setup-chat-bridge.mjs [enable|disable|status]');
if(command!=='status')await atomicJSON(file,{enabled:command==='enable'});
console.log(`Private Chat bridge: ${(await jsonFile(file,{})).enabled===true?'enabled':'disabled'}`);
if(command!=='status')console.log('Restart the desktop app to apply. No network listener or tunnel has been started.');
const binary=join(homedir(),'.codex','plugins','cache','codex-zotero-local','codex-zotero','0.1.0','dist','chat-bridge.mjs');
console.log(`Tunnel stdio entrypoint: ${binary}`);
