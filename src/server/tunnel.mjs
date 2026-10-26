// User-owned private tunnel settings. Only App tools call this manager; never model tools.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { atomicJSON, jsonFile } from './files.mjs';
const exec = promisify(execFile);
const exists = path => access(path).then(()=>true,()=>false);
const ID = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function hasRecentPoll(metrics, now = Date.now()) {
  const values=[...metrics.matchAll(/^commands_poll_last_successful_timestamp_seconds(?:\{[^}\n]*\})?\s+([^\s]+)/gm)].map(m=>Number(m[1]));
  return values.some(seconds=>Number.isFinite(seconds)&&seconds>0&&now/1000-seconds>=-10&&now/1000-seconds<=90);
}
export function tunnelError(error) {
  const text=String(error?.stderr || error?.message || '');
  if (/401|unauthorized|invalid.api.key/i.test(text)) return '运行密钥无效或已过期，请更换 OpenAI 运行密钥。';
  if (/403|forbidden|permission|not.allowed/i.test(text)) return '账号缺少隧道权限，请检查 Tunnels Read + Use 和工作区关联。';
  if (/404|not.found|does.not.exist|unknown.alias/i.test(text)) return '找不到隧道或本地连接，请核对隧道 ID 后重新连接。';
  if (/timeout|timed.out|ETIMEDOUT|ENOTFOUND|ECONN/i.test(text)) return '连接超时或网络不可达，请检查网络后刷新状态。';
  return '连接操作未完成，请检查隧道 ID、运行密钥和网络后重试。';
}
export class TunnelManager {
  constructor({root, bridgeFile, setBridge, getBridge, binary=join(homedir(),'.codex','codex-zotero-runtime','tunnel-client','tunnel-client'), run=exec, fetcher=fetch, platform=process.platform, arch=process.arch}) {
    Object.assign(this,{root,bridgeFile,setBridge,getBridge,binary,run,fetcher,platform,arch});
    this.directory=join(root,'chat-connection');this.file=join(this.directory,'settings.json');this.keyFile=join(this.directory,'runtime-key');
    this.alias='zotero-'+createHash('sha256').update(root).digest('hex').slice(0,12);this.busy=null;this.lastError='';
  }
  async config() {
    const saved=await jsonFile(this.file,{});
    return {tunnelId:typeof saved.tunnelId==='string'?saved.tunnelId.slice(0,120):'',autoConnect:saved.autoConnect===true};
  }
  async cli(args,timeout=45000) {
    // Isolate aliases/profiles from unrelated manually configured tunnels. Do not inherit API credentials.
    const env=Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','SSL_CERT_FILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    // Official compatibility shim closes the gap between initialize and App tool calls.
    // The caller still owns initialize; this only supplies its mandatory notification.
    env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION='true';
    for(const key of ['CODEX_ZOTERO_PYTHON','CODEX_ZOTERO_LAYOUT_MODEL','CODEX_ZOTERO_API','CODEX_ZOTERO_CACHE'])if(process.env[key])env[key]=process.env[key];
    env.TUNNEL_CLIENT_STATE_DIR=join(this.directory,'runtime');
    return this.run(this.binary,args,{timeout,maxBuffer:256*1024,env});
  }
  async recentPoll(data) {
    // Direct connections may have no proxy-health entry. Verify actual successful polls instead.
    try {
      const url=new URL('/metrics',data.ui_url || data.health_url);
      if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)return false;
      const response=await this.fetcher(url,{signal:AbortSignal.timeout(3000),redirect:'error'});
      if(!response.ok)return false;
      const reader=response.body.getReader();let bytes=0;const chunks=[];
      try {for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>512*1024)return false;chunks.push(value);}}
      finally {await reader.cancel().catch(()=>{});}
      return hasRecentPoll(Buffer.concat(chunks).toString());
    } catch {return false;}
  }
  async status(force=false) {
    const cfg=await this.config(), installed=await exists(this.binary), keyConfigured=await exists(this.keyFile);
    const base={...cfg,installed,keyConfigured,bridgeEnabled:!!this.getBridge(),busy:this.busy,error:this.lastError,chatVerified:false};
    if(this.busy)return {...base,state:this.busy};
    if(!installed)return {...base,state:'missing-client'};
    if(!cfg.tunnelId||!keyConfigured)return {...base,state:'unconfigured'};
    if(!force&&this.cached&&Date.now()-this.cached.at<5000)return {...base,...this.cached.value};
    if(this.checking)return this.checking;
    this.checking=(async()=>{
      let value;
      try {
        const {stdout}=await this.cli(['runtimes','status',this.alias,'--json'],10000);const data=JSON.parse(stdout);
        if(typeof data.process_running!=='boolean')throw new Error('Unsupported runtime status');
        const running=data.process_running===true, poll=data.control_plane_poll_health?.state;
        const routeReady=poll==='healthy'||poll==='direct'||((!poll||poll==='unknown')&&data.healthy===true&&data.ready===true&&await this.recentPoll(data)), routeFailed=poll==='failed';
        const ready=running&&data.healthy===true&&data.ready===true&&routeReady;
        value={state:ready?'ready':routeFailed?'error':running?'starting':'stopped',processRunning:running,healthy:data.healthy===true,ready,
          error: data.error || data.remote_error ? tunnelError({message:data.error||data.remote_error}) : routeFailed?'本地进程已启动，但无法联系 OpenAI 隧道。请检查网络与账号权限。':this.lastError};
      } catch(error) {
        const missing=/not.found|not.known|does.not.exist|unknown.alias|no.such/i.test(String(error.stderr||error.message));
        value={state:missing?'stopped':'error',processRunning:false,ready:false,error:this.lastError||(missing?'':tunnelError(error))};
      }
      this.cached={at:Date.now(),value};return {...base,...value};
    })().finally(()=>{this.checking=null;});
    return this.checking;
  }
  async exclusive(name,fn) {
    if(this.busy)throw new Error('另一个连接操作正在进行，请稍候。');
    this.busy=name;this.lastError='';this.cached=null;
    try {await fn();} catch(error) {this.lastError=error.userMessage||tunnelError(error);throw new Error(this.lastError);}
    finally {this.busy=null;}
    return this.status(true);
  }
  async configure({tunnelId,apiKey='',autoConnect=false}) {
    if(!ID.test(tunnelId))throw new Error('隧道 ID 应以 tunnel_ 开头，请从 OpenAI Platform 复制完整 ID。');
    if(typeof apiKey!=='string'||apiKey.length>4096||/[\r\n\0]/.test(apiKey))throw new Error('运行密钥格式无效。');
    return this.exclusive('saving',async()=>{
      const previous=await this.config();
      // Stop an existing connection before switching its identity or credentials.
      if((previous.tunnelId&&previous.tunnelId!==tunnelId)||apiKey.trim())await this.stopRuntime();
      await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);
      if(apiKey.trim()) {await writeFile(this.keyFile,apiKey.trim(),{mode:0o600});await chmod(this.keyFile,0o600);}
      if(!await exists(this.keyFile))throw Object.assign(new Error(),{userMessage:'请填写 OpenAI 隧道运行密钥；MinerU 密钥不能用于这里。'});
      await atomicJSON(this.file,{tunnelId,autoConnect:!!autoConnect});
    });
  }
  async install() {
    if(this.busy)throw new Error('另一个连接操作正在进行，请稍候。');
    this.installation=this.exclusive('installing',async()=>{
      if(this.platform!=='darwin'||!['arm64','x64'].includes(this.arch))throw Object.assign(new Error(),{userMessage:'当前安装器仅支持 macOS Apple 芯片和 Intel。'});
      if(await exists(this.binary))return;
      const request=async(url,limit)=>{
        const r=await this.fetcher(url,{signal:AbortSignal.timeout(90000),headers:{'Accept':'application/vnd.github+json'}});
        if(!r.ok)throw Object.assign(new Error(`Download HTTP ${r.status}`),{userMessage:'无法下载官方连接组件，请检查网络或稍后重试。'});
        const reader=r.body.getReader(),chunks=[];let size=0;
        try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Download too large');chunks.push(value);}}
        finally {await reader.cancel().catch(()=>{});}
        return Buffer.concat(chunks);
      };
      const release=JSON.parse((await request('https://api.github.com/repos/openai/tunnel-client/releases/latest',2*1024*1024)).toString());
      if(!/^v\d+\.\d+\.\d+$/.test(release.tag_name))throw new Error('Invalid release');
      const name=`tunnel-client-${release.tag_name}-darwin-${this.arch==='x64'?'amd64':'arm64'}.zip`;
      const asset=name=>{const item=release.assets?.find(a=>a.name===name);const expected=`https://github.com/openai/tunnel-client/releases/download/${release.tag_name}/${name}`;if(item?.browser_download_url!==expected)throw new Error('Invalid release asset');return expected;};
      const sums=(await request(asset('SHA256SUMS.txt'),1024*1024)).toString();
      const expected=sums.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]?.replace(/^\*/,'')===name)?.[0];
      if(!/^[a-f0-9]{64}$/.test(expected||''))throw new Error('Missing checksum');
      const zip=await request(asset(name),128*1024*1024);
      if(createHash('sha256').update(zip).digest('hex')!==expected)throw Object.assign(new Error(),{userMessage:'下载文件校验失败，没有安装。请重试。'});
      const files=unzipSync(zip,{filter:f=>f.name.split('/').at(-1)==='tunnel-client'&&f.originalSize<128*1024*1024});
      const entries=Object.values(files);if(entries.length!==1)throw new Error('Invalid archive');
      const parent=join(this.binary,'..');await mkdir(parent,{recursive:true,mode:0o700});
      const temporary=this.binary+'.download';await writeFile(temporary,entries[0],{mode:0o700});await rename(temporary,this.binary);
    }).catch(()=>null);
    return this.status();
  }
  async start() {
    return this.exclusive('starting',async()=>{
      const cfg=await this.config();if(!cfg.tunnelId||!await exists(this.keyFile))throw Object.assign(new Error(),{userMessage:'请先保存隧道 ID 和 OpenAI 运行密钥。'});
      if(!ID.test(cfg.tunnelId))throw Object.assign(new Error(),{userMessage:'已保存的隧道 ID 无效，请重新复制并保存。'});
      if(!await exists(this.binary))throw Object.assign(new Error(),{userMessage:'请先安装连接组件。'});
      await this.setBridge(true);
      const command=[process.execPath,this.bridgeFile,'--managed-reader','--state-root',this.root].map(quote).join(' ');
      await this.cli(['runtimes','connect','--alias',this.alias,'--profile',this.alias,'--profile-dir',join(this.directory,'profiles'),
        '--tunnel-id',cfg.tunnelId,'--runtime-api-key',`file:${this.keyFile}`,'--mcp-command',command,'--json']);
    });
  }
  async stopRuntime() {
    if(!await exists(this.binary))return;
    try {const {stdout}=await this.cli(['runtimes','status',this.alias,'--json']);
      const running=JSON.parse(stdout).process_running;
      if(running===false)return;
      if(running!==true)throw Object.assign(new Error(),{userMessage:'无法确认本地进程状态，未清除凭据。请刷新后重试。'});
    } catch(error) {if(/not.found|not.known|does.not.exist|unknown.alias|no.such/i.test(String(error.stderr||error.message)))return;throw error;}
    await this.cli(['runtimes','stop',this.alias,'--json']);
    const {stdout}=await this.cli(['runtimes','status',this.alias,'--json']);
    if(JSON.parse(stdout).process_running!==false)throw Object.assign(new Error(),{userMessage:'连接尚未确认停止，请稍后刷新；未清除运行凭据。'});
  }
  async stop({clear=false}={}) {
    return this.exclusive('stopping',async()=>{
      await this.stopRuntime();await this.setBridge(false);
      const cfg=await this.config();await atomicJSON(this.file,{...cfg,autoConnect:false});
      if(clear){await rm(this.keyFile,{force:true});await rm(this.file,{force:true});}
    });
  }
  async resume() {if((await this.config()).autoConnect)await this.start().catch(()=>{});}
}
