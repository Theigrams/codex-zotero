// Verify the distributable after extraction, including paths with spaces.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const [archive,pdf]=process.argv.slice(2);if(!archive||!pdf)throw new Error('Usage: node test/package-preflight.mjs ARCHIVE PDF');
const root=await mkdtemp(join(tmpdir(),'zotero package '));
execFileSync('/usr/bin/unzip',['-q',archive,'-d',root]);
const plugin=join(root,'codex-zotero');
const manifest=JSON.parse(await readFile(join(plugin,'plugin.json'),'utf8'));
const mcp=JSON.parse(await readFile(join(plugin,'mcp.json'),'utf8'));
assert.equal(manifest.name,'codex-zotero');assert.equal(manifest.extensions['com.openai'].requires_local_executor,true);
assert.ok(mcp.mcpServers['codex-zotero'].args[0].startsWith('${PLUGIN_ROOT}/'));
const dry=JSON.parse(execFileSync('/bin/sh',[join(plugin,'dist','start.sh'),'install','--dry-run'],{encoding:'utf8'}));assert.equal(dry.valid,true);
const transport=new StdioClientTransport({command:'/bin/sh',args:[join(plugin,'dist','start.sh')],env:{...process.env,CODEX_ZOTERO_STATE:join(root,'state'),CODEX_ZOTERO_CACHE:join(root,'cache')},stderr:'pipe'});
const client=new Client({name:'package-verification',version:'1'});
try {
 await client.connect(transport);
 const tools=(await client.listTools()).tools;
 assert.ok(tools.find(t=>t.name==='paper_full_text'));
 const opened=await client.callTool({name:'file_open',arguments:{},_meta:{'openai/resource':{path:pdf}}});
 assert.ok(!opened.isError,JSON.stringify(opened));const docId=opened.structuredContent.active.document.id;
 const text=await client.callTool({name:'read_pages',arguments:{docId,from:1,to:1}});
 assert.ok(!text.isError);assert.ok(text.content[0].text.length>40);
 const settings=tools.find(t=>t.name==='reader_settings');assert.ok((await client.readResource({uri:settings._meta.ui.resourceUri})).contents[0].text.includes('tunnelForm'));
 console.log(JSON.stringify({pass:true,checks:['portable manifests','installer dry run','path with spaces','actual stdio launch','PDF helper opens fixture','page text returned','Chat settings packaged']}));
}finally{await client.close();await transport.close();await rm(root,{recursive:true,force:true});}
