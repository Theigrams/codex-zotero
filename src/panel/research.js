import { MAX_RESEARCH_PAPERS, RESEARCH_GOALS } from '../shared/research.mjs';

const $ = id => document.getElementById(id);
const valid = p => p && /^[A-Z0-9]{8}$/.test(p.itemKey) && typeof p.title === 'string';

export class ResearchPanel {
  constructor({host,onChange,prepare}) {
    Object.assign(this,{host,onChange,prepare});
    this.papers=[];this.objective=RESEARCH_GOALS[0];this.includeAnnotations=true;this.acks=[];this.pending=[];
    const restored=host.extensions?.modelContext?.getCurrent();
    const saved=restored?.structuredContent?.research;
    if(saved){this.papers=(saved.papers||[]).filter(valid).slice(0,MAX_RESEARCH_PAPERS);this.objective=String(saved.objective||this.objective).slice(0,1000);this.includeAnnotations=saved.includeAnnotations!==false;
      for(const p of this.papers){const src=restored.content?.find(c=>c._meta?.['zotero/paperKey']===p.itemKey)?._meta?.['openai/thumbnail']?.src;if(typeof src==='string'&&src.startsWith('data:image/png;base64,')&&src.length<1024*1024)p.thumbnail=src;}
    }
    $('researchGoalOptions').replaceChildren(...RESEARCH_GOALS.map(value=>{const node=document.createElement('option');node.value=value;return node;}));
    $('researchGoal').value=this.objective;$('researchAnnotations').checked=this.includeAnnotations;
    $('researchButton').onclick=()=>this.open();$('researchClose').onclick=()=>this.close();
    $('researchSearchButton').onclick=()=>this.search();
    $('researchSearch').onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();this.search();}};
    $('researchNative').onclick=()=>this.chooseNative();
    $('researchGoal').oninput=()=>{this.objective=$('researchGoal').value.slice(0,1000);this.changed();};
    $('researchAnnotations').onchange=()=>{this.includeAnnotations=$('researchAnnotations').checked;this.changed();};
    $('researchClear').onclick=()=>{this.papers=[];this.changed();};
    $('researchUse').onclick=()=>this.action(async()=>{await this.prepare();this.close();this.notice('研究文献已加入上下文，请在 ChatGPT 对话框中提出问题');});
    $('researchOcr').onclick=()=>this.action(async()=>{const result=await host.call('research_ocr_start',{itemKeys:this.keys(),userRequested:true});this.batchId=result.batchId;await this.refresh();});
    $('researchCancel').onclick=()=>this.action(async()=>{await host.call('research_ocr_cancel',{batchId:this.batchId});this.batchId=null;await this.refresh();});
    $('researchPreviewClose').onclick=()=>this.closePreview();
    $('researchPreviewPrev').onclick=()=>this.preview(this.previewKey,this.previewPage-1);
    $('researchPreviewNext').onclick=()=>this.preview(this.previewKey,this.previewPage+1);
    this.hostChanged=e=>{if(!Object.hasOwn(e,'openai/modelContext'))return;const state=e['openai/modelContext'];if(this.publishing)this.pending.push(state);else this.applyHost(state);};
    host.app?.addEventListener('hostcontextchanged',this.hostChanged);
    this.render();
  }
  keys(){return this.papers.map(p=>p.itemKey);}
  structured(){return {objective:this.objective,includeAnnotations:this.includeAnnotations,papers:this.papers.map(({thumbnail,...p})=>p)};}
  signature(){return JSON.stringify(this.structured())+JSON.stringify(this.papers.map(p=>!!p.thumbnail));}
  endPublish(id){if(id)this.acks=[...this.acks,id].slice(-16);this.publishing=false;const pending=this.pending;this.pending=[];pending.forEach(s=>this.applyHost(s));}
  applyHost(state){
    if(state?.updateId&&this.acks.includes(state.updateId))return;
    const keys=new Set((state?.content||[]).map(c=>c._meta?.['zotero/paperKey']).filter(Boolean));
    const next=this.papers.filter(p=>keys.has(p.itemKey));
    if(next.length!==this.papers.length){this.papers=next;this.changed();}
  }
  changed(){if(this.destroyed)return;this.render();this.onChange();}
  notice(text){$('researchNotice').textContent=text;}
  async action(fn){try{await fn();}catch(e){this.notice(e.message);}}
  open(){$('researchPanel').hidden=false;$('researchButton').setAttribute('aria-expanded','true');$('researchSearch').focus();if(!this.rows)this.search();this.refresh();this.timer ||= setInterval(()=>{if(!$('researchPanel').hidden||this.batchId)this.refresh();},5000);}
  closePreview(){this.previewSeq=(this.previewSeq||0)+1;$('researchPreview').hidden=true;}
  close(){$('researchPanel').hidden=true;this.closePreview();$('researchButton').setAttribute('aria-expanded','false');$('researchButton').focus();}
  async search(){
    const generation=this.generation=(this.generation||0)+1;
    this.notice('正在搜索…');
    await this.action(async()=>{
      const result=await this.host.call('research_candidates',{query:$('researchSearch').value});
      if(this.generation!==generation)return;this.rows=result.papers;this.renderRows();this.notice(this.rows.length?'勾选论文可跨搜索累积；点击封面预览':'没有找到论文');
      // Small, cached first-page previews; never render the entire library at once.
      let next=0;
      await Promise.all([0,1].map(async()=>{while(next<this.rows.length&&this.generation===generation){const p=this.rows[next++];try{const data=await this.host.call('research_preview_data',{itemKey:p.itemKey,page:1});if(this.generation!==generation)return;p.thumbnail=data.image;const selected=this.papers.find(x=>x.itemKey===p.itemKey);if(selected){selected.thumbnail=p.thumbnail;this.changed();}else this.renderRows();}catch{}}}));
    });
  }
  async chooseNative(){await this.action(async()=>{
    const r=await this.host.call('research_choose',{query:$('researchSearch').value});
    if(r.cancelled)return;
    if(r.requiresSelection){await this.search();this.notice('当前宿主请使用下方复选框选择论文');return;}
    const additions=(r.papers||[]).filter(p=>valid(p)&&!this.papers.some(x=>x.itemKey===p.itemKey));
    if(this.papers.length+additions.length>MAX_RESEARCH_PAPERS)throw new Error(`最多选择 ${MAX_RESEARCH_PAPERS} 篇，请先移除部分文献`);
    this.objective=r.objective;this.includeAnnotations=r.includeAnnotations;
    $('researchGoal').value=this.objective;$('researchAnnotations').checked=this.includeAnnotations;
    for(const p of r.papers||[])if(valid(p)&&!this.papers.some(x=>x.itemKey===p.itemKey)&&this.papers.length<MAX_RESEARCH_PAPERS)this.papers.push({...p,thumbnail:this.rows?.find(x=>x.itemKey===p.itemKey)?.thumbnail});
    this.changed();this.notice('已选择研究文献');
  });}
  async toggle(row,checked){
    if(!checked){this.papers=this.papers.filter(p=>p.itemKey!==row.itemKey);this.changed();return;}
    if(this.papers.some(p=>p.itemKey===row.itemKey))return;
    if(this.papers.length>=MAX_RESEARCH_PAPERS){this.notice(`最多选择 ${MAX_RESEARCH_PAPERS} 篇`);this.renderRows();return;}
    this.papers.push({...row});this.changed();
    await this.refresh();
  }
  async refresh(){
    if(this.destroyed||this.refreshing||!this.papers.length)return;
    this.refreshing=true;const keys=this.keys();
    try{
      const result=await this.host.call('research_status',{itemKeys:keys});
      if(this.destroyed)return;
      const signature=this.signature();
      this.papers=this.papers.map(p=>({...p,...result.papers.find(x=>x.itemKey===p.itemKey)}));
      if(this.batchId){const batch=await this.host.call('research_ocr_status',{batchId:this.batchId});this.papers=this.papers.map(p=>{const task=batch.tasks.find(t=>t.itemKey===p.itemKey);return {...p,batchState:task?.state,batchError:task?.error};});if(batch.complete)this.batchId=null;}
      if(signature!==this.signature())this.changed();else this.render();
    }catch(e){this.notice(e.message);}finally{this.refreshing=false;}
  }
  async preview(key,page=1){await this.action(async()=>{
    const seq=this.previewSeq=(this.previewSeq||0)+1;
    const p=await this.host.call('research_preview_data',{itemKey:key,page,detail:true});
    if(seq!==this.previewSeq)return;
    this.previewKey=key;this.previewPage=page;
    $('researchPreviewTitle').textContent=p.title;$('researchPreviewPage').textContent=`P${page} / ${p.pageCount}`;
    $('researchPreviewImage').src=p.image;$('researchPreviewPrev').disabled=page===1;$('researchPreviewNext').disabled=page===p.pageCount;
    $('researchPreview').hidden=false;$('researchPreviewClose').focus();
  });}
  renderRows(){
    $('researchResults').replaceChildren(...(this.rows||[]).map(p=>{
      const row=document.createElement('li');
      const check=document.createElement('input');check.type='checkbox';check.checked=this.keys().includes(p.itemKey);check.ariaLabel=`选择 ${p.title}`;check.onchange=()=>this.toggle(p,check.checked);
      const cover=document.createElement('button');cover.className='research-cover';cover.title=`预览 ${p.title}`;cover.onclick=()=>this.preview(p.itemKey);
      if(p.thumbnail){const img=document.createElement('img');img.src=p.thumbnail;img.alt='论文首页';cover.append(img);}else cover.textContent='预览';
      const label=document.createElement('div');const title=document.createElement('strong');title.textContent=p.title;const meta=document.createElement('small');meta.textContent=[p.creators,p.year].filter(Boolean).join(' · ');label.append(title,meta);
      row.append(check,cover,label);return row;
    }));
  }
  render(){
    $('researchButton').textContent=this.papers.length?`研究 ${this.papers.length}`:'研究';
    $('researchUse').disabled=$('researchOcr').disabled=!this.papers.length;
    $('researchCancel').hidden=!this.batchId;
    $('researchSelected').replaceChildren(...this.papers.map(p=>{
      const row=document.createElement('li');const label=document.createElement('div');
      const title=document.createElement('strong');title.textContent=p.title;
      const status=document.createElement('small');status.textContent=p.error||p.batchError||`${p.pageCount||'?'} 页 · ${p.annotationCount??'?'} 条批注 / ${p.commentCount??'?'} 条评论 · ${p.fullText?.available?'全文可用':p.batchState==='queued'?'等待识别':p.batchState==='cancelled'?'已取消':p.job&&!['done','failed','cancelled'].includes(p.job.state)?`识别中 ${p.job.done}/${p.job.total}`:p.job?.state==='failed'?`识别失败：${p.job.error}`:'按需识别'}`;
      label.append(title,status);const remove=document.createElement('button');remove.textContent='×';remove.ariaLabel=`移除 ${p.title}`;remove.onclick=()=>this.toggle(p,false);
      row.append(label,remove);return row;
    }));this.renderRows();
  }
  destroy(){this.destroyed=true;this.generation=(this.generation||0)+1;this.previewSeq=(this.previewSeq||0)+1;$('researchPanel').hidden=true;$('researchPreview').hidden=true;clearInterval(this.timer);this.host.app?.removeEventListener('hostcontextchanged',this.hostChanged);}
}
