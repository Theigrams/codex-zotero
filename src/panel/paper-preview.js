import { connect } from './host.js';

async function main() {
// A resource-picker preview is independent of the active reading panel.
const host = await connect({displayModes:['inline','fullscreen']});
const $ = id => document.getElementById(id);
let paper, sequence = 0;
function show(value) {
  if (!value?.image || !value?.itemKey) return;
  paper=value; $('title').textContent=value.title;
  $('page').textContent=`P${value.page} / ${value.pageCount}`;
  $('image').src=value.image; $('previous').disabled=value.page<=1; $('next').disabled=value.page>=value.pageCount;
  $('status').textContent='';
}
async function load(itemKey,page=1) {
  const seq=++sequence; $('status').textContent='正在载入…';
  try {const value=await host.call('research_preview_data',{itemKey,page,detail:true});if(seq===sequence)show(value);}
  catch(e){if(seq===sequence)$('status').textContent=e.message;}
}
host.onResult?.(result=>show(result?.structuredContent));
show(host.initialResult?.structuredContent);
const key=new URLSearchParams(location.search).get('itemKey');
if(!paper&&key)load(key);
$('previous').onclick=()=>paper&&load(paper.itemKey,paper.page-1);
$('next').onclick=()=>paper&&load(paper.itemKey,paper.page+1);

}
main().catch(e => { document.getElementById('status').textContent=e.message; });
