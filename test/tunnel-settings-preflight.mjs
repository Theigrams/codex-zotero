// Real settings UI and server with an isolated fake tunnel-client: no external connection or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
const pdf=process.argv[process.argv.indexOf('--pdf')+1];if(!process.argv.includes('--pdf'))throw new Error('Pass --pdf');
const root=await mkdtemp(join(tmpdir(),'zotero-tunnel-ui-')),binary=join(root,'fake-tunnel'),callsFile=join(root,'calls.json');
await writeFile(binary,`#!${process.execPath}\nconst fs=require('fs');const file=${JSON.stringify(callsFile)};let s;try{s=JSON.parse(fs.readFileSync(file))}catch{s={running:false,calls:[]}};const args=process.argv.slice(2);s.calls.push(args);if(args[1]==='connect')s.running=true;if(args[1]==='stop')s.running=false;fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({process_running:s.running,healthy:s.running,ready:s.running,control_plane_poll_health:{state:"direct"}}));`,{mode:0o700});
const server=spawn(process.execPath,['out/plugin/dist/server.mjs','--standalone','--pdf',pdf],{env:{...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache'),CODEX_ZOTERO_FAST:'1',CODEX_ZOTERO_TUNNEL_BINARY:binary},stdio:['ignore','ignore','pipe']});
const url=await new Promise((resolve,reject)=>{let log='';server.stderr.on('data',c=>{log+=c;const m=log.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});server.on('exit',()=>reject(new Error(log)));});
let browser;
try {
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,defaultViewport:{width:1100,height:900}});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url.replace('/panel','/host'));
 await page.waitForSelector('iframe');const frame=await(await page.$('iframe')).contentFrame();await frame.waitForFunction(()=>window.__reader?.doc);
 await frame.click('#settingsButton');await frame.click('#chatConnection summary');
 await frame.waitForFunction(()=>document.getElementById('tunnelState').textContent==='待配置');
 await frame.type('#tunnelId','invalid');await frame.type('#tunnelKey','PRIVATE-TEST-RUNTIME-KEY');assert.equal(await frame.$eval('#tunnelKey',n=>n.type),'password');
 await frame.click('#tunnelSave');await frame.waitForFunction(()=>document.getElementById('tunnelNote').textContent.includes('隧道 ID'));
 await frame.$eval('#tunnelId',n=>n.value='tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');await frame.type('#tunnelKey','PRIVATE-TEST-RUNTIME-KEY');
 await frame.click('#tunnelSave');await frame.waitForFunction(()=>document.getElementById('tunnelConnect').disabled===false);
 assert.equal(await frame.$eval('#tunnelKey',n=>n.value),'');assert.equal(await frame.$eval('#tunnelAuto',n=>n.checked),false);
 await frame.click('#tunnelConnect');await frame.waitForFunction(()=>document.getElementById('tunnelState').textContent==='隧道已就绪');
 await page.waitForFunction(()=>window.__modelContexts?.at(-1)?.structuredContent.readingAccess.readerSession);
 assert.ok(!(await page.evaluate(()=>JSON.stringify(window.__modelContexts))).includes('PRIVATE-TEST'));
 await page.setViewport({width:375,height:812});assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:'diagnostics/tunnel-settings-mobile.png'});
 await frame.click('#tunnelClear');await frame.waitForFunction(()=>document.getElementById('tunnelState').textContent==='待配置');
 await page.waitForFunction(()=>!window.__modelContexts?.at(-1)?.structuredContent.readingAccess.readerSession);
 assert.equal(await frame.$eval('#tunnelId',n=>n.value),'');assert.equal(await frame.$eval('#tunnelConnect',n=>n.disabled),true);
 const calls=JSON.parse(await readFile(callsFile,'utf8'));assert.ok(calls.calls.some(a=>a[1]==='connect'));assert.ok(calls.calls.some(a=>a[1]==='stop'));assert.ok(!JSON.stringify(calls).includes('PRIVATE-TEST'));
 await frame.type('#tunnelKey','UNSAVED-KEY');await frame.click('#settingsClose');assert.equal(await frame.$eval('#tunnelKey',n=>n.value),'');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({pass:true,checks:['own tunnel ID validation','password input','no automatic connection','save clears secret','native managed start','dynamic reader session','secret excluded from context and arguments','mobile width','stop and clear','session removed','close clears unsaved secret']}));
} finally {await browser?.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(root,{recursive:true,force:true});}
