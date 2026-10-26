// Bound the web tunnel's work queue. Retry reads only; a failed write may already have committed.
const RETRY_READS=new Set(['render_page','render_strip','render_preview','page_text','page_links','layout_page','annotations_list','ocr_job_status','prefs_get','home_list','notes_list','research_candidates','research_prepare','research_preview_data','panel_poll','panel_hello']);
const CACHE_READS=new Set(['page_text','page_links']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const initializationError=error=>/not initialized|initialization_required|send initialize/i.test(String(error?.message || error));
const transient=error=>initializationError(error)||/timeout|timed out|\b429\b|\b50[234]\b|temporar|connection (?:closed|reset)/i.test(String(error?.message||error));
function readable(error){return initializationError(error)?new Error('阅读器连接尚未就绪。请稍后重试；若持续出现，请刷新 Chat 的插件连接。'):error;}
export function remoteCalls(send,{wait=sleep,attempts=3,imageBudget=48*1024*1024}={}) {
  const queue=[],pending=new Map(),cache=new Map(),images=new Map();let active=0,imageBytes=0;
  const pump=()=>{
    while(active<2 && queue.length){
      queue.sort((a,b)=>a.priority-b.priority);
      const job=queue.shift();active++;
      (async()=>{
        for(let attempt=0;;attempt++){
          try{const result=await send(job.name,job.args);if(result.isError)throw new Error(result.content?.find(c=>c.type==='text')?.text||'读取失败');return result;}
          catch(error){if(!RETRY_READS.has(job.name)||!transient(error)||attempt>=attempts-1)throw readable(error);await wait(300*2**attempt);}
        }
      })().then(job.resolve,job.reject).finally(()=>{active--;pump();});
    }
  };
  return (name,args={})=>{
    const {priority:ignoredPriority,...imageArgs}=args;
    const key=name+JSON.stringify(name==='render_page'?imageArgs:args),read=RETRY_READS.has(name);
    if(name==='render_page'&&images.has(key)){const entry=images.get(key);images.delete(key);images.set(key,entry);return Promise.resolve(entry.result);}
    if(CACHE_READS.has(name)&&cache.has(key))return Promise.resolve(cache.get(key));
    if(read&&pending.has(key))return pending.get(key);
    const priority=/^(?:annotation_|ocr_job_(?:start|cancel))/.test(name)?0:name==='render_page'?(args.priority?4:1):name==='panel_poll'?3:2;
    const promise=new Promise((resolve,reject)=>queue.push({name,args,resolve,reject,priority}));
    if(read)pending.set(key,promise);
    promise.then(result=>{
      if(name==='render_page'){
        const size=result.structuredContent?.data?.length||0;
        if(size && size<=imageBudget){images.set(key,{result,size});imageBytes+=size;while(imageBytes>imageBudget){const oldest=images.keys().next().value;imageBytes-=images.get(oldest).size;images.delete(oldest);}}
      }
      if(CACHE_READS.has(name)){cache.set(key,result);while(cache.size>24)cache.delete(cache.keys().next().value);}},()=>{}).finally(()=>pending.delete(key));
    pump();return promise;
  };
}
