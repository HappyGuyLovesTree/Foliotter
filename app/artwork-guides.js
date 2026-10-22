/* Separate commentary from source text, and bind every guide to its actual image. */
'use strict';
((root)=>{
  const roles={'direct-caption':'直接图注',context:'同章上下文','cross-reference':'交叉参照'};
  function validate(payload,manifest,manifestSha,reader){
    const entries=new Map(),rejected=[];
    if(payload?.schemaVersion!==1 || payload.datasetId!==reader.datasetId ||
       !reader.readingSha256 || payload.readingSha256!==reader.readingSha256 ||
       payload.artworksSha256!==manifestSha || !Array.isArray(payload.entries))
      return {entries,rejected,error:'原画导读与当前底本不匹配'};
    const items=new Map(manifest.items.map(x=>[x.imageId,x])),counts=new Map();
    for(const entry of payload.entries)counts.set(entry.imageId,(counts.get(entry.imageId)||0)+1);
    for(const entry of payload.entries){
      try{
        const item=items.get(entry.imageId);
        if(!item || counts.get(entry.imageId)!==1 || entry.assetSha256!==item.asset.sha256)throw Error('图像身份不符');
        for(const key of ['observation','sourceNote','reading','question'])
          if(typeof entry[key]!=='string'||!entry[key].trim())throw Error('说明字段缺失');
        if(!Array.isArray(entry.sources)||!entry.sources.length)throw Error('说明缺少依据');
        const caption=reader.getSourceUnit(entry.captionUnitId),captionBlocks=(caption?.zh||[]).map(p=>p.id);
        if(!caption || caption.sectionId!==item.readingTargets[0].sectionId)throw Error('图号来源不符');
        const marker=text=>text.toLowerCase().replace(/[\s\[\],，]/g,'');
        if(!(caption.zh||[]).some(p=>marker(p.text)===marker(item.marker)))throw Error('图号文字不符');
        const seen=new Set();
        for(const source of entry.sources){
          if(!['note','unit'].includes(source.type)||!roles[source.role])throw Error('来源类型无效');
          if(seen.has(source.type+source.id))throw Error('来源重复');seen.add(source.type+source.id);
          const actual=source.type==='note'?reader.getSourceNote(source.id):reader.getSourceUnit(source.id);
          if(!actual)throw Error('来源不存在');
          if(source.role==='direct-caption'){
            if(source.type!=='note')throw Error('直接图注类型不符');
            if(actual.language==='zh'){
              if(!actual.referenceBlockIds?.some(id=>captionBlocks.includes(id)))throw Error('直接图注回链不符');
            }else{
              const owner=reader.getSourceUnit(source.captionUnitId);
              const follows=(owner?.en||[]).some(p=>{
                if(!actual.referenceBlockIds?.includes(p.id))return false;
                let before='';
                for(const segment of p.segments||[]){
                  if(segment.type==='note'&&segment.noteId===source.id){
                    const tail=before.match(/\[([^\]]+)\]\s*$/);
                    if(tail&&marker(tail[1])===marker(item.marker))return true;
                  }
                  before+=segment.text||'';
                }
                return false;
              });
              if(!follows)throw Error('英文图注未紧随本图标记');
            }
          }
          if(source.role==='context' && actual.sectionId!==caption.sectionId)throw Error('上下文不在本章');
        }
        entries.set(entry.imageId,entry);
      }catch(error){rejected.push({imageId:entry.imageId,reason:error.message});}
    }
    return {entries,rejected,error:null};
  }
  function render(container,entry,reader,openTarget){
    container.replaceChildren();
    delete container.dataset.imageId;
    const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
    if(!entry){container.append(el('p','artwork-guide-unavailable','此图导读暂不可用。可先查看原图和书中位置。'));return;}
    container.dataset.imageId=entry.imageId;
    container.append(el('p','artwork-guide-kicker','看画导读'));
    for(const [key,label] of [['observation','先看画面'],['sourceNote','书中依据'],['reading','一种读法']]){
      const section=el('section','artwork-guide-section');
      section.append(el('h3','',label),el('p','',entry[key]));container.append(section);
    }
    const question=el('div','artwork-guide-question');
    question.append(el('h3','','带着问题再看'),el('p','',entry.question));container.append(question);
    const sources=el('details','artwork-guide-sources');
    sources.append(el('summary','',`展开原注与上下文 · ${entry.sources.length}`));
    sources.append(el('p','artwork-guide-source-intro','以下为底本原文。上方观察与读法是本站编写的阅读辅助。'));
    for(const source of entry.sources){
      const actual=source.type==='note'?reader.getSourceNote(source.id):reader.getSourceUnit(source.id);
      if(!actual)continue;
      const detail=el('details','artwork-guide-source');detail.dataset.sourceId=source.id;detail.dataset.sourceRole=source.role;
      const lang=actual.language||((actual.zh||[]).length?'zh':'en');
      const text=source.type==='note'?actual.paragraphs:(actual[lang]||[]).map(p=>p.text);
      const isCaption=source.type==='unit'&&/^\s*\[image[^\]]+\][\s,，]*$/i.test(text.join(' '));
      detail.append(el('summary','',`${isCaption?'图页位置':roles[source.role]} · ${lang==='zh'?'中文':'English'}${actual.label?' '+actual.label:''}`));
      const body=el('div','artwork-guide-original');body.lang=lang;
      for(const paragraph of text||[])body.append(el('p','',paragraph));
      detail.append(body);
      const origin=actual.source||(actual[lang]||[])[0]?.source;
      if(origin)detail.append(el('p','artwork-guide-source-path',`${origin.file}${origin.anchor?'#'+origin.anchor:''}`));
      if(source.type==='unit'){
        const button=el('button','text-button',isCaption?'查看书中此页及前后文 →':'读这段及前后文 →');button.type='button';
        button.addEventListener('click',()=>openTarget({unitId:actual.id,language:lang,sectionId:actual.sectionId}));
        detail.append(button);
      }
      sources.append(detail);
    }
    container.append(sources);
  }
  const api={validate,render};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.ArtworkGuides=api;
})(typeof window!=='undefined'?window:globalThis);
