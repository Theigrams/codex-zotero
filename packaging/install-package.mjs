// Double-click installer for the self-contained macOS package. No npm/build tools required.
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source=dirname(fileURLToPath(import.meta.url));
const plugin=JSON.parse(await readFile(join(source,'plugin.json'),'utf8'));
const exists=path=>access(path).then(()=>true,()=>false);
if(process.platform!=='darwin')throw new Error('此安装包只适用于 macOS。');
if(Number(process.versions.node.split('.')[0])<22)throw new Error('需要 Node.js 22 或更新版本，请更新桌面应用。');
const candidates=['/Applications/ChatGPT.app','/Applications/Codex.app',join(homedir(),'Applications/ChatGPT.app'),join(homedir(),'Applications/Codex.app')];
let cli;
for(const base of candidates){const path=join(base,'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');if(await exists(path)){cli=path;break;}}
if(!cli)throw new Error('找不到 ChatGPT/Codex 桌面应用。请先安装桌面应用，再运行安装器。');
const market='codex-zotero-local',root=join(homedir(),'.codex','marketplaces',market),dest=join(root,'plugin');
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({valid:true,name:plugin.name,version:plugin.version,source:resolve(source),desktopFound:true}));process.exit(0);}
await mkdir(dest,{recursive:true});await cp(source,dest,{recursive:true,force:true});
await mkdir(join(root,'.agents','plugins'),{recursive:true});
await writeFile(join(root,'.agents','plugins','marketplace.json'),JSON.stringify({name:market,interface:{displayName:'Codex Zotero'},plugins:[{name:plugin.name,source:{source:'local',path:'./plugin'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]},null,2));
const call=args=>execFileSync(cli,args,{encoding:'utf8',maxBuffer:2*1024*1024});
const inventory=JSON.parse(call(['plugin','marketplace','list','--json']));
if(!inventory.marketplaces.some(m=>m.name===market))call(['plugin','marketplace','add',root]);
const cache=join(homedir(),'.codex','plugins','cache',market,plugin.name);
const installed=[join(cache,plugin.version),join(cache,'local')];
const existing=[];for(const path of installed)if(await exists(path))existing.push(path);
if(existing.length){for(const path of existing)await cp(source,path,{recursive:true,force:true});}
else call(['plugin','add',`${plugin.name}@${market}`]);
const fonts=join(homedir(),'Library','Fonts');await mkdir(fonts,{recursive:true});
for(const name of JSON.parse(await readFile(join(source,'fonts','files.json'),'utf8')))if(!await exists(join(fonts,name)))await cp(join(source,'fonts',name),join(fonts,name));
console.log('Zotero 阅读器已安装。请用 ⌘Q 退出并重新打开桌面应用，然后在插件中打开「Zotero 阅读器」。');
console.log('普通阅读不需要密钥。MinerU 和可选的 Chat 私有连接均在阅读器设置中填写你自己的配置。');
