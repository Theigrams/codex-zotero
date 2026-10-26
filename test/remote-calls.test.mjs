import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteCalls} from '../src/panel/remote-calls.js';
import {remotePagePlan} from '../src/shared/remote-page.mjs';
test('remote read retries handshake failures, coalesces concurrent work, and caches immutable glyphs',async()=>{
 let calls=0;const waits=[];
 const call=remoteCalls(async()=>{calls++;if(calls<3)throw new Error('MCP server is not initialized; send initialize');return {structuredContent:{text:'evidence'}};},{wait:async ms=>waits.push(ms)});
 const [a,b]=await Promise.all([call('page_text',{docId:'a',page:1}),call('page_text',{docId:'a',page:1})]);
 assert.equal(a,b);assert.equal(calls,3);assert.deepEqual(waits,[300,600]);
 await call('page_text',{docId:'a',page:1});assert.equal(calls,3);
 await call('page_text',{docId:'b',page:1});assert.equal(calls,4);
});
test('remote writes never replay and persistent initialization errors become actionable',async()=>{
 let calls=0;const call=remoteCalls(async()=>{calls++;throw new Error('MCP server is not initialized');},{wait:async()=>{}});
 await assert.rejects(()=>call('annotation_create',{}),/连接尚未就绪/);assert.equal(calls,1);
 await assert.rejects(()=>call('render_page',{}),/刷新 Chat/);assert.equal(calls,4);
});
test('remote queue bounds simultaneous requests and prioritizes rendering over polling',async()=>{
 let active=0,max=0;const starts=[],release=[];
 const call=remoteCalls(async(name)=>{active++;max=Math.max(max,active);starts.push(name);await new Promise(r=>release.push(r));active--;return {};});
 const a=call('page_text',{page:1}),b=call('page_text',{page:2}),c=call('panel_poll'),d=call('render_page');
 release.shift()();await a;await new Promise(r=>setTimeout(r,0));assert.equal(starts[2],'render_page');
 while(release.length){release.shift()();await new Promise(r=>setTimeout(r,0));}
 await Promise.all([b,c,d]);assert.equal(max,2);
});
test('whole page rendering preserves geometry and bounds extreme zoom memory',()=>{
 const p=remotePagePlan(800,2,{w:600,h:900});assert.equal(p.bitmapW,1600);assert.equal(p.cssH,1200);
 const huge=remotePagePlan(8000,4,{w:600,h:900});assert.ok(huge.bitmapW<=3200);assert.ok(huge.bitmapH<=5600);
});

test('page image cache reuses back navigation, ignores priority, and evicts to a byte budget',async()=>{
 let calls=0;const call=remoteCalls(async()=>{calls++;return {structuredContent:{data:'a'.repeat(6)}};},{imageBudget:10});
 await call('render_page',{docId:'a',page:1,priority:0});await call('render_page',{docId:'a',page:1,priority:1});assert.equal(calls,1);
 await call('render_page',{docId:'a',page:2});await call('render_page',{docId:'a',page:1,priority:0});assert.equal(calls,3);
});
