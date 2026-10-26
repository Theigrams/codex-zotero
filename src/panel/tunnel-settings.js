const $=id=>document.getElementById(id);
const states={unconfigured:'待配置', 'missing-client':'未安装连接组件', stopped:'未连接', starting:'正在连接', saving:'正在保存', installing:'正在安装连接组件', stopping:'正在断开', ready:'隧道已就绪', error:'连接异常'};
export class TunnelSettings {
  constructor({call,openUrl}) {
    Object.assign(this,{call,openUrl});this.generation=0;this.dirty=false;
    $('tunnelForm').onsubmit=e=>{e.preventDefault();this.save();};
    for(const id of ['tunnelId','tunnelKey','tunnelAuto'])$(id).addEventListener('input',()=>{this.dirty=true;});
    $('tunnelInstall').onclick=()=>this.action('tunnel_install');
    $('tunnelConnect').onclick=()=>this.action('tunnel_start');
    $('tunnelDisconnect').onclick=()=>this.action('tunnel_stop');
    $('tunnelClear').onclick=()=>this.action('tunnel_stop',{clear:true});
    $('tunnelRefresh').onclick=()=>this.refresh();
    const open=async url=>{try {await openUrl(url);}catch {$('tunnelNote').textContent='无法打开账号页面，请在浏览器中打开 OpenAI Platform 或 ChatGPT 设置。';}};
    $('tunnelPlatform').onclick=()=>open('https://platform.openai.com/settings/organization/tunnels');
    $('tunnelKeys').onclick=()=>open('https://platform.openai.com/settings/organization/api-keys');
    $('tunnelChat').onclick=()=>open('https://chatgpt.com/#settings/Connectors');
    $('tunnelCopy').onclick=async()=>{
      try {await navigator.clipboard.writeText($('tunnelId').value.trim());$('tunnelNote').textContent='已复制隧道 ID，在 Chat 添加连接时粘贴。';}
      catch {$('tunnelNote').textContent='复制失败，请选择上方隧道 ID 手动复制。';}
    };
  }
  open(){this.active=true;this.generation++;this.dirty=false;this.refresh();}
  close(){this.active=false;this.generation++;clearTimeout(this.timer);$('tunnelKey').value='';}
  async refresh(){
    clearTimeout(this.timer);const generation=this.generation;
    try {const data=await this.call('tunnel_status');if(this.active&&generation===this.generation)this.render(data);}
    catch {if(this.active&&generation===this.generation)$('tunnelState').textContent='暂时无法读取连接状态，请刷新。';}
    finally {if(this.active&&generation===this.generation)this.timer=setTimeout(()=>this.refresh(),5000);}
  }
  async action(name,args={}){
    if(this.busy)return;this.busy=true;this.disable(true);$('tunnelNote').textContent='';const generation=this.generation;
    try {const data=await this.call(name,args);if(this.active&&generation===this.generation){this.dirty=false;this.render(data);}}
    catch(e){if(this.active&&generation===this.generation)$('tunnelNote').textContent=e.message;}
    finally {this.busy=false;if(this.active&&generation===this.generation)this.refresh();}
  }
  async save(){
    const generation=this.generation;
    await this.action('tunnel_configure',{tunnelId:$('tunnelId').value.trim(),apiKey:$('tunnelKey').value.trim(),autoConnect:$('tunnelAuto').checked});
    if(this.active&&generation===this.generation)$('tunnelKey').value='';
  }
  disable(busy){for(const id of ['tunnelSave','tunnelInstall','tunnelConnect','tunnelDisconnect','tunnelClear','tunnelId','tunnelKey','tunnelAuto'])$(id).disabled=busy;}
  render(data){
    this.data=data;this.disable(this.busy||!!data.busy);
    if(!this.dirty){$('tunnelId').value=data.tunnelId||'';$('tunnelAuto').checked=!!data.autoConnect;}
    $('tunnelKey').placeholder=data.keyConfigured?'已保存在本机，留空保留':'填写 OpenAI 隧道运行密钥';
    $('tunnelState').textContent=states[data.state]||'状态未知';
    $('tunnelState').classList.toggle('connected',data.state==='ready');
    $('tunnelDetail').textContent=data.state==='ready'
      ? '隧道已就绪。在 Chat 中添加同一个隧道，并实际读取正文后，才算完成连接。'
      : data.processRunning ? '本地进程在运行，正在等待隧道就绪；若持续不变，请检查账号权限和网络。'
      : data.keyConfigured ? '配置已保存。连接后才能让 Chat 按需读取本机论文。'
      : '每位用户使用自己的隧道和运行密钥；普通阅读不需要配置。';
    $('tunnelNote').textContent=data.error||$('tunnelNote').textContent;
    if(!this.busy&&!data.busy){
      $('tunnelInstall').disabled=!!data.installed;
      $('tunnelConnect').disabled=!data.installed||!data.tunnelId||!data.keyConfigured||data.state==='ready';
      $('tunnelDisconnect').disabled=!data.processRunning&&!data.bridgeEnabled;
      $('tunnelClear').disabled=!data.tunnelId&&!data.keyConfigured;
    }
    $('tunnelCopy').disabled=!$('tunnelId').value.trim();
  }
}
