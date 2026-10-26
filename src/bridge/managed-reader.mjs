// The web connection owns its reader backend. Closing a desktop chat must not close a web PDF.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {requestBridge} from './local.mjs';
const exists=path=>access(path).then(()=>true,()=>false);
export class ManagedReader {
  constructor({root,serverFile,env=process.env}){Object.assign(this,{root,serverFile,env});this.id=randomBytes(16).toString('hex');this.closed=false;}
  async ensure(){
    if(this.closed)throw new Error('网页阅读器已关闭。');
    if(this.current)return this.current;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const env={...this.env,CODEX_ZOTERO_STATE:this.root};
      if(!env.CODEX_ZOTERO_PYTHON){const python=join(homedir(),'.codex','codex-zotero-runtime','bin','python');if(await exists(python))env.CODEX_ZOTERO_PYTHON=python;}
      if(this.closed)throw new Error('网页阅读器已关闭。');
      const child=this.child=spawn(process.execPath,[this.serverFile,'--bridge-service','--chat-bridge'],{env,stdio:['pipe','ignore','ignore','ipc']});
      child.once('exit',()=>{if(this.child===child){this.current=null;this.child=null;}});
      const id=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{child.kill();reject(new Error('本机阅读器启动超时，请检查 Zotero 与安装。'));},20000);
        child.once('message',msg=>{clearTimeout(timer);if(msg?.type==='reader-ready'&&/^[a-f0-9]{32}$/.test(msg.readerSession))resolve(msg.readerSession);else reject(new Error('本机阅读器启动响应无效。'));});
        child.once('error',()=>{clearTimeout(timer);reject(new Error('无法启动本机阅读器，请检查安装。'));});
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('本机阅读器已退出，请检查安装。'));});
      });
      await requestBridge(id,{method:'app',name:'panel_hello',arguments:{instance:this.instance||'web-backend'}});
      if(this.report)await requestBridge(id,{method:'app',name:'panel_report',arguments:this.report}).catch(()=>{this.report=null;});
      this.current=id;return id;
    })().catch(error=>{this.child?.kill();this.current=null;throw error;}).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async list(){
    const id=await this.ensure();const info=await requestBridge(id,{method:'status'});
    return [{...info,readerSession:this.id,managed:true}];
  }
  async request(id,req){
    if(id!==this.id)throw new Error('阅读器连接已更新，请调用 reader_connections 后重新打开。');
    const target=await this.ensure();
    if(req.method==='app'&&req.name==='panel_hello')this.instance=req.arguments?.instance;
    if(req.method==='app'&&req.name==='panel_report')this.report=req.arguments;
    const reply=await requestBridge(target,req);
    if(reply.result&&'readerSession' in reply.result)reply.result.readerSession=this.id;
    return reply;
  }
  async close(){
    this.closed=true;const child=this.child;if(!child)return;
    child.stdin.end();
    await new Promise(resolve=>{const t=setTimeout(()=>{child.kill();resolve();},3000);child.once('exit',()=>{clearTimeout(t);resolve();});if(child.exitCode!==null){clearTimeout(t);resolve();}});
  }
}
