// Unix socket only: no TCP listener, public URL, credentials, or document copies.
import { createServer, createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, readdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, jsonFile } from '../server/files.mjs';
import { sessionSchema, callBridgeTool } from './tools.mjs';

const REQUEST_LIMIT = 128 * 1024, RESPONSE_LIMIT = 8 * 1024 * 1024;
const socketDir = () => `/tmp/codex-zotero-${process.getuid()}`;
const socketPath = id => join(socketDir(), `${sessionSchema.parse(id)}.sock`);
const registry = root => join(root, 'bridge-sessions');

export async function startLocalBridge({ root, definitions, appCall, describe = async () => ({}) }) {
  const dir = socketDir();
  await mkdir(dir, { recursive:true, mode:0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('桥接目录不安全。');
  await chmod(dir, 0o700);
  const id = randomBytes(16).toString('hex'), path = socketPath(id);
  await mkdir(registry(root), { recursive:true, mode:0o700 });
  let closed = false, refreshing = false;
  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try { await atomicJSON(join(registry(root), `${id}.json`), { readerSession:id, updatedAt:Date.now(), ...await describe() }); }
    finally { refreshing = false; }
  };
  const clients = new Set();
  const server = createServer(socket => {
    if (clients.size >= 32) { socket.destroy(); return; }
    clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(120000, () => socket.destroy());
    let buffer = Buffer.alloc(0), handled = false;
    socket.on('data', async chunk => {
      if (handled) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > REQUEST_LIMIT) { socket.destroy(); return; }
      const end = buffer.indexOf(10); if (end < 0) return;
      handled = true;
      let reply;
      try {
        const request = JSON.parse(buffer.subarray(0,end).toString());
        if (end !== buffer.length-1) throw new Error('一次连接只接受一个请求。');
        if (request.method === 'status') reply = { readerSession:id, ...await describe() };
        else if (request.method === 'call') reply = { result:await callBridgeTool(definitions, request.name, request.arguments || {}) };
        else if (request.method === 'app' && appCall) reply = { result:await appCall(request.name, request.arguments || {}) };
        else throw new Error('未知桥接请求。');
      } catch (error) {
        reply = { error:error.name === 'ZodError' ? '工具参数无效，请检查文档 id 和参数范围。' : String(error.message).slice(0,500).replace(/\/Users\/[^\s]+/g,'[local path]') };
      }
      const data = JSON.stringify(reply)+'\n';
      socket.end(Buffer.byteLength(data) <= RESPONSE_LIMIT ? data : JSON.stringify({error:'返回内容过大，请缩小页码或字符范围。'})+'\n');
    });
  });
  await new Promise((resolve,reject) => { server.once('error',reject);server.listen(path,resolve); });
  await chmod(path,0o600);
  await refresh();
  const timer = setInterval(() => refresh().catch(() => {}),10000); timer.unref();
  return { id, refresh, async close() {
    closed=true; clearInterval(timer); for (const client of clients) client.destroy();
    await new Promise(resolve=>server.close(resolve));
    while(refreshing) await new Promise(resolve=>setTimeout(resolve,5));
    await Promise.all([rm(path,{force:true}),rm(join(registry(root),`${id}.json`),{force:true})]);
  } };
}

export function requestBridge(id, request, { timeout = 120000 } = {}) {
  return new Promise((resolve,reject) => {
    const socket = createConnection(socketPath(id)); let buffer=Buffer.alloc(0), done=false;
    const finish = (error,value) => { if(done)return;done=true;socket.destroy();error?reject(error):resolve(value); };
    socket.on('connect', () => socket.write(JSON.stringify(request)+'\n'));
    socket.setTimeout(timeout, () => finish(new Error('本地阅读器响应超时。')));
    socket.on('error', () => finish(new Error('阅读器连接已关闭；请重新打开阅读器并获取 reader_connections。')));
    socket.on('end', () => { if(!done)finish(new Error('阅读器连接意外中断。')); });
    socket.on('data', chunk => {
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length>RESPONSE_LIMIT)return finish(new Error('桥接响应过大。'));
      const end=buffer.indexOf(10);if(end<0)return;
      try {const reply=JSON.parse(buffer.subarray(0,end).toString());finish(reply.error?new Error(reply.error):null,reply);}
      catch {finish(new Error('桥接响应格式无效。'));}
    });
  });
}
export async function listBridgeSessions(root) {
  const files=await readdir(registry(root)).catch(()=>[]), sessions=[];
  // Ignore obsolete/crashed processes and cap discovery work. Never choose the first session implicitly.
  for(const file of files.filter(f=>/^[a-f0-9]{32}\.json$/.test(f))) {
    const record=await jsonFile(join(registry(root),file),null).catch(()=>null);
    if(!record || Date.now()-record.updatedAt>30000)continue;
    try {sessions.push(await requestBridge(file.slice(0,-5),{method:'status'},{timeout:1000}));}catch {}
    if(sessions.length>=64)break;
  }
  return sessions;
}
