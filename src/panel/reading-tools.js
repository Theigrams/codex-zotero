// Typed read operations for expanded desktop Apps. No generic executor and no writes.
export function registerReadingTools({ register, host, reader, research }) {
  const document = () => { if (!reader.doc) throw new Error('请先打开论文。'); return reader.doc; };
  const range = (from, to, count) => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > count) throw new Error('页码超出范围。');
  };
  const pagination = args => {
    const {offset=0,maxChars=40000,version,knownVersion}=args;
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(maxChars)||maxChars<1||maxChars>60000)throw new Error('读取范围无效。');
    if([version,knownVersion].some(v=>v!==undefined&&typeof v!=='string'))throw new Error('版本无效。');
    return {offset,maxChars,...(version?{version}:{}),...(knownVersion?{knownVersion}:{})};
  };
  const pageSchema={type:'integer',minimum:1};
  const readingSchema={offset:{type:'integer',minimum:0},maxChars:{type:'integer',minimum:1,maximum:60000},version:{type:'string'},knownVersion:{type:'string'}};
  const {knownVersion: _unused, ...annotationSchema}=readingSchema;
  const annotationOptions=args=>{const {knownVersion,...options}=pagination(args);return options;};
  const call=(name,args)=>host.callTool(name,args); // Keep content text; structuredContent intentionally excludes full bodies.
  register('reader_read_pages','Read actual local text from pages of the current paper. Reading is local, not a web search. Returns the text and page references; never starts OCR.',{from:pageSchema,to:pageSchema},[],args=>{
    const doc=document(),from=args.from??reader.currentPage(),to=args.to??from;range(from,to,doc.pageCount);
    return call('read_pages',{docId:doc.id,from,to});
  },true);
  register('reader_read_full_text','Read cached MinerU full text of the current paper, with versioned pagination. Never starts OCR. Use only when needed; follow nextOffset and reuse a version already read in this conversation.',readingSchema,[],args=>call('paper_full_text',{docId:document().id,...pagination(args)}),true);
  register('reader_read_annotations','Read the current paper’s full highlights and comments with pagination. Comments are user notes, not paper conclusions. Never writes annotations.',annotationSchema,[],args=>{
    const doc=document();return doc.itemKey?call('research_annotations',{itemKey:doc.itemKey,...annotationOptions(args)}):call('list_annotations',{docId:doc.id});
  },true);
  register('reader_ocr_status','Check the current paper’s cached OCR availability and progress without uploading.',{},[],()=>call('ocr_status',{docId:document().id}),true);
  const selected=key=>{
    const papers=research?.papers||[];
    if(!papers.some(p=>p.itemKey===key))throw new Error('该论文不在当前研究文献中。');
    return papers;
  };
  register('reader_research_status','Read OCR and annotation availability for the papers explicitly selected in this App. Never uploads.',{},[],()=>{
    const itemKeys=(research?.papers||[]).map(p=>p.itemKey);if(!itemKeys.length)throw new Error('尚未选择研究文献。');
    return call('research_status',{itemKeys});
  },true);
  register('reader_research_annotations','Read complete highlights and comments for one of this App’s selected research papers. Follow nextOffset/version.',{itemKey:{type:'string',pattern:'^[A-Z0-9]{8}$'},...annotationSchema},['itemKey'],args=>{
    selected(args.itemKey);return call('research_annotations',{itemKey:args.itemKey,...annotationOptions(args)});
  },true);
  register('reader_research_full_text','Read cached full text for one of this App’s selected research papers. Does not change the visible paper or start OCR.',{itemKey:{type:'string',pattern:'^[A-Z0-9]{8}$'},...readingSchema},['itemKey'],async args=>{
    selected(args.itemKey);
    const result=await call('research_status',{itemKeys:[args.itemKey]});
    const paper=result.structuredContent?.papers?.[0];
    if(!paper?.docId)throw new Error(paper?.error||'论文未就绪。');
    return call('paper_full_text',{docId:paper.docId,...pagination(args)});
  },true);
}
