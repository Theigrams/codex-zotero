// Extension UX through the official AppBridge. Isolated state; never submits real chat messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
const pdf = process.argv[process.argv.indexOf('--pdf')+1];
if (!process.argv.includes('--pdf')) throw new Error('Pass --pdf FILE');
const root = await mkdtemp(join(tmpdir(), 'zotero-ext-e2e-'));
const server = spawn(process.execPath, ['out/plugin/dist/server.mjs', '--standalone', '--pdf', pdf], {
  env: { ...process.env, CODEX_ZOTERO_STATE:join(root,'state'), CODEX_ZOTERO_CACHE:join(root,'cache'), CODEX_ZOTERO_FAST:'1' }, stdio:['ignore','ignore','pipe'],
});
const url = await new Promise((resolve,reject)=>{ let log=''; server.stderr.on('data',c=>{log+=c;const m=log.match(/standalone panel: (\S+)/);if(m)resolve(m[1]);});server.on('exit',()=>reject(new Error(log))); });
let browser;
try {
  browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,defaultViewport:{width:1100,height:900,deviceScaleFactor:1}});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.evaluateOnNewDocument(()=>{
    window.__webTools = {};
    Object.defineProperty(document,'modelContext',{value:{registerTool:tool=>window.__webTools[tool.name]=tool,unregisterTool:name=>delete window.__webTools[name]},configurable:true});
  });
  await page.goto(url.replace('/panel','/host'));await page.waitForSelector('iframe');
  const frame=await (await page.$('iframe')).contentFrame();
  await frame.waitForFunction(()=>window.__reader?.doc&&window.__webTools.reader_view);
  const view=JSON.parse(await frame.evaluate(()=>window.__webTools.reader_view.execute({})));
  assert.ok(view.docId);
  await frame.evaluate(()=>window.__webTools.reader_select_block.execute({page:1,index:0,attach:true}));
  await page.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent.contextBlocks.length===1);
  await frame.click('#ask');await frame.type('#askInput','解释这个段落');await frame.click('#askDraft');
  await page.waitForFunction(()=>window.__messages.length===1);
  let message=await page.evaluate(()=>window.__messages.at(-1));
  assert.deepEqual(message._meta['openai/message'],{target:'active',send:false});
  assert.ok(message.content[0].text.includes('解释这个段落'));
  await frame.click('#ask');await frame.type('#askInput','另开讨论');await frame.select('#askTarget','new');await frame.click('#askDraft');
  await page.waitForFunction(()=>window.__messages.length===2);
  message=await page.evaluate(()=>window.__messages.at(-1));
  assert.deepEqual(message._meta['openai/message'],{target:'new',send:false});
  assert.ok(message.content.some(c=>c._meta?.['zotero/blockId']),'new conversation includes pinned blocks');
  await frame.click('#ask');await frame.type('#askInput','在新对话发送');await frame.select('#askTarget','new');await frame.click('#askSend');
  await page.waitForFunction(()=>window.__messages.length===3);
  assert.deepEqual((await page.evaluate(()=>window.__messages.at(-1)))._meta['openai/message'],{target:'new',send:true});
  await frame.click('#ask');await frame.type('#askInput','当前对话发送');await frame.click('#askSend');
  await page.waitForFunction(()=>window.__messages.length===4);
  assert.deepEqual((await page.evaluate(()=>window.__messages.at(-1)))._meta['openai/message'],{target:'active',send:true});
  await frame.click('#readerMore');await frame.click('#openOriginal');
  await page.waitForFunction(()=>window.__openedFiles.length===1);
  assert.equal((await page.evaluate(()=>window.__openedFiles))[0],pdf);
  const route=await frame.evaluate(()=>`/paper/${window.__reader.doc.id}?page=1&rect=10,20,30,40`);
  await page.evaluate(url=>window.__setHostContext({'openai/deepLink':{url}}),route);
  await frame.waitForFunction(()=>window.__selection.current?.rect?.join() === '10,20,30,40');
  await page.evaluate(()=>window.__setHostContext({theme:'dark',styles:{variables:{'--color-background-primary':'#202124'}},safeAreaInsets:{top:8,right:10,bottom:12,left:10},'openai/interactionCursor':'default'}));
  await frame.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  const appearance=await frame.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,cursor:getComputedStyle(document.getElementById('readerMore')).cursor,bottom:getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')}));
  assert.equal(appearance.bg,'rgb(32, 33, 36)');assert.equal(appearance.cursor,'default');assert.equal(appearance.bottom,'12px');
  await page.setViewport({width:375,height:812});
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.ok(await frame.$eval('#ask',n=>n.offsetHeight<32),'compact toolbar labels must not wrap vertically');
  await page.screenshot({path:'diagnostics/extensions-mobile.png'});
  await page.setViewport({width:1100,height:900});
  await page.evaluate(()=>window.__setHostContext({theme:'light',styles:{variables:{'--color-background-primary':'#ffffff'}},safeAreaInsets:{top:0,right:0,bottom:0,left:0}}));
  // Native settings use a separate app resource and never call panel_hello.
  const settings=await browser.newPage();await settings.goto(url.replace('/panel','/settings'));
  await settings.waitForSelector('#settings:not([hidden])');
  assert.equal(await settings.$eval('#message',n=>n.hidden),true);
  await settings.click('input[value="rounded"]');
  await frame.waitForFunction(()=>window.__reader.mode==='rounded'||document.getElementById('debug').textContent.includes('rounded')).catch(async()=>{
    assert.equal(await frame.evaluate(()=>window.__reader.renderMode||window.__reader.mode),'rounded');
  });
  assert.ok(await frame.evaluate(()=>window.__reader.doc));
  await settings.close();
  const fileView=await frame.evaluate(()=>({tabs:[{id:window.__reader.doc.id,title:window.__reader.doc.title}],active:{document:window.__reader.doc}}));
  await page.evaluate(async view=>{window.__callOverrides.file_open=view;await window.__activate({view:'file',file:{name:'test.pdf',resourceUri:'host-resource://test-pdf'}});},fileView);
  await page.waitForFunction(()=>window.__subscriptions.some(s=>s.method==='resources/subscribe'));
  const before=await page.evaluate(()=>window.__toolCalls.filter(n=>n==='file_open').length);
  await page.evaluate(()=>window.__resourceUpdated('host-resource://test-pdf'));
  await page.waitForFunction(before=>window.__toolCalls.filter(n=>n==='file_open').length>before,{},before);
  const id=await frame.evaluate(()=>window.__contexts.items[0].id);
  await frame.evaluate(id=>window.__webTools.reader_remove_context.execute({id}),id);
  await page.waitForFunction(()=>window.__modelContexts.at(-1)?.structuredContent.contextBlocks.length===0);
  const invalid=JSON.parse(await frame.evaluate(()=>window.__webTools.reader_go_to_page.execute({page:999999})));
  assert.ok(invalid.error);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pass:true,checks:['current draft does not send','new draft carries context','send to new conversation','send to current conversation','open original','deep link activation','host theme and cursor','safe area','narrow viewport','settings does not retire reader','native setting sync','file entrypoint subscribes','file update reloads','live page tools','context removal sync','invalid page rejected']}));
} finally { await browser?.close();server.kill();await rm(root,{recursive:true,force:true}); }
