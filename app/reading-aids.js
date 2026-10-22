'use strict';
(() => {
  const langs=['zh','en'], relations={'direct-reference':'本段原书注引用','chapter-background':'同章书注背景','term-background':'词语背景','mixed-reference':'本段与同章书注'}, types={person:'人物',concept:'概念',work:'作品',role:'角色'};
  const textOf=p=>'segments' in p?(p.segments||[]).filter(s=>s.type==='text').map(s=>s.text||'').join(''):p.text||'';
  const segmentsOf=p=>'segments' in p?p.segments:[{type:'text',text:p.text||''}];
  const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)),x=>x.toString(16).padStart(2,'0')).join('');
  const dateOK=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
  const nonempty=v=>typeof v==='string'&&v.trim().length>0;
  const counts=items=>{const m=new Map();for(const x of items)m.set(x?.id,(m.get(x?.id)||0)+1);return m;};
  async function validate(data,aids,readingSha) {
    const fatal=[],rejected=[],valid=[],entries=new Map(),units=new Map(data.units.map(u=>[u.id,u])),sections=new Map(data.sections.map(s=>[s.id,s])),aliases=data.legacy?.blockAliases||{};
    if(!aids || aids.schemaVersion!==1)fatal.push('schema-version');
    if(aids?.datasetId!==data.metadata?.datasetId)fatal.push('dataset-id');
    if(aids?.readingSha256!==readingSha)fatal.push('reading-sha256');
    if(!Array.isArray(aids?.entries)||!Array.isArray(aids?.bindings)||!dateOK(aids?.reviewedAt)||aids?.coverage?.basis!=='valid-bindings-per-unit-language')fatal.push('json-shape');
    if(fatal.length)return {fatal,rejected,valid,entries};
    const entryCounts=counts(aids.entries),bindingCounts=counts(aids.bindings),hashes=new Map();
    const resolveNote=(id,uid)=>data.notesById?.[id]||data.notesById?.[data.legacy?.noteAliasesByUnit?.[uid]?.[id]];
    const entryCheck=(e,uid)=>{
      const reasons=[],notes=[];
      if(!e||typeof e!=='object'||!Array.isArray(e.sources))return {reasons:['entry-shape'],notes};
      if(!e||!['person','concept','work','role'].includes(e.type)||!langs.includes(e.language))reasons.push('entry-enum');
      if(e?.reviewStatus!=='reviewed'||!dateOK(e?.reviewedAt))reasons.push('entry-review');
      if(!['id','term','shortText'].every(k=>nonempty(e?.[k])))reasons.push('entry-text');
      if(!Array.isArray(e?.aliases)||!e.aliases.every(nonempty))reasons.push('entry-aliases');
      if('excludeWithin' in e&&(!Array.isArray(e.excludeWithin)||!e.excludeWithin.every(nonempty)))reasons.push('entry-exclude-within');
      if('evidenceUnitIds' in e){
        const evidence=e.evidenceUnitIds;
        if(!Array.isArray(evidence)||!evidence.length||!evidence.every(nonempty))reasons.push('entry-evidence-shape');
        else {
          if(new Set(evidence).size!==evidence.length)reasons.push('entry-evidence-duplicate');
          if(evidence.some(uid=>{const u=units.get(uid);return !u||!sections.get(u.sectionId)?.readingOrder?.[e.language]?.includes(uid)||!u[e.language]?.some(p=>textOf(p).trim());}))reasons.push('entry-evidence-unavailable');
        }
      }
      const scope=e?.scope?.sectionIds;
      if(!Array.isArray(scope)||!scope.length||scope.some(s=>!sections.has(s))||new Set(scope).size!==scope.length)reasons.push('entry-scope');
      if(!Array.isArray(e?.sources)||!e.sources.length)reasons.push('missing-source');
      for(const s of e?.sources||[]){
        if(s?.kind!=='local-version-note'){reasons.push('unapproved-source');continue;}
        const n=resolveNote(s.noteId,uid);if(!n){reasons.push('missing-source');continue;}notes.push(n);
        if(n.language!==e.language)reasons.push('source-language');
        if(!['bookId','file','anchor'].every(k=>n.source?.[k])||!n.sourceBlockIds?.length||!Array.isArray(n.referenceBlockIds))reasons.push('source-locator');
      }
      if(!notes.length)reasons.push('missing-source');return {reasons,notes};
    };
    for(const e of aids.entries)if(nonempty(e?.id)&&entryCounts.get(e.id)===1)entries.set(e.id,e);
    for(const b of aids.bindings){
      const reasons=[];const reject=()=>rejected.push({...b,reasons:[...new Set(reasons)]});
      if(!b||!['id','entryId','unitId','sectionId','language','blockId','quote','textSha256','relation'].every(k=>nonempty(b[k]))){reasons.push('binding-shape');reject();continue;}
      if(bindingCounts.get(b.id)!==1)reasons.push('binding-id-duplicate');
      const e=entries.get(b.entryId);if(!e){reasons.push('entry-missing');reject();continue;}
      const ec=entryCheck(e,b.unitId);if(ec.reasons.length){reasons.push('entry-invalid',...ec.reasons);reject();continue;}
      const u=units.get(b.unitId);if(!u){reasons.push('unit-missing');reject();continue;}
      if(!langs.includes(b.language)||e.language!==b.language)reasons.push('binding-language');
      if(u.sectionId!==b.sectionId||!e.scope.sectionIds.includes(b.sectionId))reasons.push('binding-section');
      if(!sections.get(b.sectionId)?.readingOrder?.[b.language]?.includes(b.unitId))reasons.push('order-membership');
      const paragraphs=u[b.language]||[], candidates=paragraphs.filter(p=>aliases[p.id]===b.blockId);
      const p=paragraphs.find(p=>p.id===b.blockId)||(candidates.length===1?candidates[0]:null);
      if(!p){reasons.push('block-membership');reject();continue;}
      const t=textOf(p);if(!hashes.has(t))hashes.set(t,digest(t));if(await hashes.get(t)!==b.textSha256)reasons.push('text-hash');
      if(!['start','end','occurrenceIndex'].every(k=>Number.isInteger(b[k]))){reasons.push('range-type');reject();continue;}
      const boundary=i=>i>=0&&i<=t.length&&!(i>0&&i<t.length&&t.charCodeAt(i-1)>=0xd800&&t.charCodeAt(i-1)<=0xdbff&&t.charCodeAt(i)>=0xdc00&&t.charCodeAt(i)<=0xdfff);
      if(!boundary(b.start)||!boundary(b.end)||b.start>=b.end)reasons.push('range-boundary');else if(t.slice(b.start,b.end)!==b.quote)reasons.push('quote');
      let hits=[],pos=0;while(pos<=t.length){pos=t.indexOf(b.quote,pos);if(pos<0)break;hits.push(pos);pos++;}
      if(b.occurrenceIndex<0||hits[b.occurrenceIndex]!==b.start)reasons.push('occurrence');
      let offset=0,inside=false;for(const s of segmentsOf(p)){if(s.type!=='text')continue;const end=offset+(s.text||'').length;if(offset<=b.start&&b.start<b.end&&b.end<=end)inside=true;offset=end;}
      if(!inside)reasons.push('segment-boundary');
      if(b.matching==='lexical'||e.excludeWithin?.length){
        const before=Array.from(t.slice(0,b.start)).at(-1),after=Array.from(t.slice(b.end))[0],word=c=>!!c&&/[\p{L}\p{N}_]/u.test(c);
        if(b.language==='en'&&(word(before)||word(after)))reasons.push('english-word-boundary');
        for(const term of e.excludeWithin||[]){let at=-1;while((at=t.indexOf(term,at+1))>=0)if(at<=b.start&&b.start<b.end&&b.end<=at+term.length){reasons.push('exclude-within');break;}}
      }
      const canonical=aliases[p.id]||p.id,direct=ec.notes.map(n=>n.referenceBlockIds.includes(canonical)),same=ec.notes.map(n=>n.sectionId===b.sectionId&&n.language===b.language);
      if(b.relation==='direct-reference'){if(!direct.every(Boolean))reasons.push('relation-direct');}
      else if(b.relation==='chapter-background'){if(!same.every(Boolean)||direct.some(Boolean))reasons.push('relation-chapter');}
      else if(b.relation==='mixed-reference'){if(!same.every(Boolean)||!direct.some(Boolean)||direct.every(Boolean))reasons.push('relation-mixed');}
      else if(b.relation==='term-background'){if(direct.every(Boolean)||same.every(Boolean))reasons.push('relation-term');}
      else reasons.push('relation-enum');
      if(reasons.length)reject();else valid.push({...b,paragraphId:p.id,entry:e,notes:ec.notes});
    }
    const conflicts=new Set(),groups=new Map();
    for(const b of valid){const key=JSON.stringify([b.unitId,b.language,b.paragraphId]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
    for(const group of groups.values()){group.sort((a,b)=>a.start-b.start);for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){const a=group[i],b=group[j];if(b.start>=a.end)break;conflicts.add(a.id);conflicts.add(b.id);}}
    for(const b of valid)if(conflicts.has(b.id))rejected.push({...b,reasons:['overlap']});
    const safeEntries=new Map([...entries].filter(([id,e])=>!entryCheck(e,aids.bindings.find(b=>b?.entryId===id)?.unitId).reasons.length));
    return {fatal,rejected,valid:valid.filter(b=>!conflicts.has(b.id)),entries:safeEntries};
  }
  function create(options){
    const {data,reader,readingBytes,renderUnit,renderNotes,openPanel,refresh}=options,units=new Map(data.units.map(u=>[u.id,u])),sections=new Map(data.sections.map(s=>[s.id,s]));
    let status='loading',error='',report=null,enabled=true,serial=0,view=null,root=null,aids=null;
    let byUnit=new Map(),byEntry=new Map(),dictionaryQuery='',dictionaryLanguage='all',dictionaryLimit=40;
    const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
    const button=(text,action,cls='aid-action')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
    const title=(s,l)=>s?.title?.[l]||s?.title?.zh||s?.title?.en||'阅读章节';
    const getBindings=(uid,l)=>byUnit.get(`${uid}:${l}`)||[];
    async function load(){const token=++serial;status='loading';error='';report=null;refresh();if(root?.isConnected)render();
      try{const response=await fetch('/data/reading-aids.json',{cache:'no-cache'});if(!response.ok)throw Error(`词注文件返回 ${response.status}`);const parsed=await response.json();const checked=await validate(data,parsed,await digest(readingBytes));if(token!==serial)return;if(checked.fatal.length)throw Error('词注与本次正文不匹配，已停用标注。');aids=parsed;report=checked;byUnit=new Map();byEntry=new Map();for(const b of report.valid){const key=`${b.unitId}:${b.language}`;if(!byUnit.has(key))byUnit.set(key,[]);byUnit.get(key).push(b);if(!byEntry.has(b.entryId))byEntry.set(b.entryId,[]);byEntry.get(b.entryId).push(b);}status='ready';}
      catch(e){if(token!==serial)return;status='unavailable';error=e.message||'词注暂不可用';}
      refresh();if(root?.isConnected)render();
    }
    function annotate(p,paragraph,l,unit){
      if(status!=='ready'||!enabled)return;
      const bindings=getBindings(unit.id,l).filter(b=>b.paragraphId===paragraph.id);if(!bindings.length)return;
      let offset=0;for(const n of [...p.childNodes]){if(n.nodeType!==3)continue;const start=offset,end=start+n.textContent.length;offset=end;const matches=bindings.filter(b=>b.start>=start&&b.end<=end).sort((a,b)=>a.start-b.start);if(!matches.length)continue;
        const frag=document.createDocumentFragment();let cursor=0;for(const b of matches){frag.append(document.createTextNode(n.textContent.slice(cursor,b.start-start)));const mark=button(b.quote,()=>{if(options.openEntry?.(b.entry.id))return;view={unitId:unit.id,language:l,before:2,after:2,kind:'entry',binding:b};openPanel();},'aid-term');mark.dataset.aidBinding=b.id;mark.setAttribute('aria-label',`${b.quote}：查看${types[b.entry.type]}词注，${relations[b.relation]}`);frag.append(mark);cursor=b.end-start;}frag.append(document.createTextNode(n.textContent.slice(cursor)));n.replaceWith(frag);
      }
    }
    function show(targetRoot,anchor,binding){root=targetRoot;if(!view||view.unitId!==anchor.unitId||view.language!==anchor.language)view={...anchor,before:2,after:2,kind:'main'};if(binding)view={...view,kind:'entry',binding};render();}
    function showDictionary(){
      root.append(button('返回前后文与词注',()=>{view.kind='main';render();}),el('h3','aid-dictionary-title','全书人物、概念与典故'),el('p','aid-intro','搜索中英文名称，查看简注、原书注与书中出现的位置。释义依据本地版本书注整理；词面相同的地方仍需结合上下文理解。'));
      const label=el('label','aid-search-label','检索词条'),input=el('input','aid-dictionary-search');input.type='search';input.placeholder='如：斐乐蒙、Logos、以赛亚';input.value=dictionaryQuery;input.id='aid-dictionary-search';label.htmlFor=input.id;
      const langLabel=el('label','aid-search-label','词条语言'),select=el('select','aid-dictionary-language');select.id='aid-dictionary-language';langLabel.htmlFor=select.id;
      for(const [value,name] of [['all','中文与 English'],['zh','中文'],['en','English']]){const option=el('option','',name);option.value=value;select.append(option);}select.value=dictionaryLanguage;
      const count=el('p','aid-state'),list=el('div','aid-dictionary-results');count.setAttribute('aria-live','polite');root.append(label,input,langLabel,select,count,list);
      const update=()=>{
        list.replaceChildren();const query=dictionaryQuery.trim().toLocaleLowerCase();
        const entries=[...report.entries.values()].filter(e=>(dictionaryLanguage==='all'||e.language===dictionaryLanguage)&&[e.term,...e.aliases,e.shortText].join(' ').toLocaleLowerCase().includes(query)).sort((a,b)=>a.term.localeCompare(b.term,'zh'));
        const grouped=new Map();for(const e of entries){const key=e.language+':'+e.term.toLocaleLowerCase();if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(e);}const groups=[...grouped.values()];
        count.textContent=`${groups.length} 个名称 · ${entries.length} 条来源记录${groups.length>dictionaryLimit?` · 当前显示 ${dictionaryLimit} 个`:''}`;
        for(const group of groups.slice(0,dictionaryLimit)){
          const e=group.find(e=>e.reviewMethod==='source-grounded-glossary')||group[0],bb=byEntry.get(e.id)||[],item=el('article','aid-dictionary-item');
          item.append(button(e.term,()=>{if(options.openEntry?.(e.id))return;view.kind='entry';view.entryReturn='dictionary';view.binding=bb[0]||{entry:e,notes:e.sources.map(source=>data.notesById[source.noteId]).filter(Boolean)};render();},'aid-dictionary-term'));
          item.append(el('p','aid-state',`${types[e.type]} · ${e.language==='zh'?'中文':'English'} · ${new Set(group.flatMap(e=>(byEntry.get(e.id)||[]).map(b=>b.unitId))).size} 段${group.length>1?` · ${group.length} 项来源说明`:''}`),el('p','aid-dictionary-excerpt',e.shortText));list.append(item);
        }
        if(!entries.length)list.append(el('p','aid-state','没有找到这个词条。可换用另一种语言名称，或从本章原书注继续查找。'));
        if(groups.length>dictionaryLimit)list.append(button('再显示 40 条',()=>{dictionaryLimit+=40;update();}));
      };
      input.addEventListener('input',()=>{dictionaryQuery=input.value;dictionaryLimit=40;update();});select.addEventListener('change',()=>{dictionaryLanguage=select.value;dictionaryLimit=40;update();});update();
    }
    function openNote(noteId,owner){const n=data.notesById?.[noteId]||data.notesById?.[data.legacy?.noteAliasesByUnit?.[owner.id]?.[noteId]];if(!n)return;const a=reader.getAnchor();if(!view)view={...a,before:2,after:2};view={...view,kind:'note',note:n,noteOwner:owner};openPanel();}
    function render(){if(!root||!view)return;const focusText=root.contains(document.activeElement)?document.activeElement.textContent:null;const finish=()=>{if(focusText!==null){const controls=[...root.querySelectorAll('button')];(controls.find(x=>x.textContent===focusText)||controls[0])?.focus({preventScroll:true});}};root.replaceChildren();const u=units.get(view.unitId),l=view.language,s=sections.get(u?.sectionId);if(!u)return;
      if(view.kind==='dictionary'&&status==='ready'){showDictionary();finish();return;}
      if(view.kind==='note'){const back=()=>{view.kind=view.noteReturn||'main';view.noteReturn=null;render();};root.append(button(view.noteReturn==='entry'?'返回词条':'返回前后文与词注',back));renderNotes([view.note],root,view.noteOwner||u,back);finish();return;}
      if(view.kind==='entry'){
        const b=view.binding;root.append(button(view.entryReturn==='dictionary'?'返回全书词典':'返回前后文与词注',()=>{view.kind=view.entryReturn||'main';render();}));const article=el('section','aid-definition');article.append(el('h3','',b.entry.term),el('p','aid-relation',`${types[b.entry.type]} · ${relations[b.relation]||'书注词条'}`),el('p','aid-short',b.entry.shortText),el('p','aid-review',b.entry.reviewMethod==='source-grounded-glossary'?'释义据本版书注整理，正文按词面定位；请结合前后文理解，不把每次出现都视为同一种象征。':'据所提供电子书书注整理；已核绑定不代表专家审核。'));
        for(const n of b.notes)article.append(button(`查看原书注 ${n.label||''} · ${title(sections.get(n.sectionId),n.language)} · ${n.language==='zh'?'中文':'English'}`,()=>{view.kind='note';view.note=n;view.noteOwner=u;view.noteReturn='entry';render();}));
        for(const uid of b.entry.evidenceUnitIds||[]){const evidence=units.get(uid);if(evidence?.[b.entry.language]?.length)article.append(button(`查看定义所在正文 · ${title(sections.get(evidence.sectionId),b.entry.language)}`,()=>reader.openTarget({unitId:uid,language:b.entry.language},{reason:'查阅词条正文出处',focus:true})));}
        const related=[...report.entries.values()].filter(e=>e.id!==b.entry.id&&e.language===b.entry.language&&e.term.toLocaleLowerCase()===b.entry.term.toLocaleLowerCase());if(related.length){const variants=el('details','aid-occurrences');variants.append(el('summary','',`其他来源说明 · ${related.length}`));for(const e of related)variants.append(button(`${e.term} · ${title(sections.get(e.scope.sectionIds[0]),e.language)}`,()=>{view.binding=(byEntry.get(e.id)||[])[0]||{entry:e,notes:e.sources.map(source=>data.notesById[source.noteId]).filter(Boolean)};render();}));article.append(variants);}
        const occurrences=byEntry.get(b.entry.id)||[],unique=[...new Map(occurrences.map(item=>[item.unitId,item])).values()];if(unique.length){const positions=el('details','aid-occurrences');positions.append(el('summary','',`书中位置 · ${unique.length} 段`));const list=el('div');positions.append(list);let shown=0;const more=button('再显示 20 处',()=>add());const add=()=>{more.remove();for(const match of unique.slice(shown,shown+20)){const chapter=sections.get(match.sectionId),order=chapter?.readingOrder?.[match.language]||[];list.append(button(`${title(chapter,match.language)} · 第 ${order.indexOf(match.unitId)+1} 段`,()=>reader.openTarget({unitId:match.unitId,language:match.language,blockId:match.blockId},{reason:'词典查阅原文',focus:true})));}shown+=20;if(shown<unique.length)list.append(more);};positions.addEventListener('toggle',()=>{if(positions.open&&!shown)add();});article.append(positions);}
        root.append(article);finish();return;
      }
      root.append(el('p','aid-intro','按本章原书顺序读前后文。预览与展开保持当前阅读位置；选择“打开这一段”才跳转。'));
      const intro=el('section','aid-word-list');intro.append(el('h3','','本段词注'));
      if(status==='loading')intro.append(el('p','aid-state','正在核对本地词注…'));
      else if(status==='unavailable'){intro.append(el('p','aid-state',`${error} 正文、前后文和原书注仍可阅读。`),button('重新读取词注',load));}
      else{
        const bindings=getBindings(u.id,l),unique=[...new Map(bindings.map(b=>[b.entryId,b])).values()];
        if(!unique.length)intro.append(el('p','aid-state','本段暂无词注，可看前后文/本章书注。'));
        for(const b of unique)intro.append(button(`${b.entry.term} · ${relations[b.relation]}`,()=>{if(options.openEntry?.(b.entry.id))return;view.kind='entry';view.entryReturn='main';view.binding=b;render();},'aid-list-term'));
        intro.append(button('本章人物、概念与典故',()=>options.openChapter?.(u.sectionId,l),'aid-dictionary-open'));
        intro.append(button('查全书人物、概念与典故',()=>{if(options.openDictionary?.())return;view.kind='dictionary';render();},'aid-dictionary-open'));
        const toggle=button(enabled?'隐藏正文词注标记':'显示正文词注标记',()=>{enabled=!enabled;refresh();render();});toggle.setAttribute('aria-pressed',String(enabled));intro.append(toggle);
        const covered=new Set(report.valid.map(b=>b.unitId)).size,context=new Set(data.sections.flatMap(x=>langs.flatMap(ll=>x.readingOrder?.[ll]||[]))).size;
        intro.append(el('p','aid-coverage',`全书 ${context} 单元均可看前后文 · ${report.entries.size} 条词条记录 · ${report.valid.length} 处标记，分布于 ${covered} 个单元。未标记段落仍可查全书词典与原书注。`));
        if(report.rejected.length)intro.append(el('p','aid-state',`${report.rejected.length} 条绑定未通过校验，已隔离。`));
        const scope=el('details','aid-scope');scope.append(el('summary','','全书注释范围与来源说明'));scope.addEventListener('toggle',()=>{if(!scope.open||scope.dataset.loaded)return;scope.dataset.loaded='true';for(const ll of langs){const bb=report.valid.filter(b=>b.language===ll);scope.append(el('p','aid-state',`${ll==='zh'?'中文':'English'}：${[...report.entries.values()].filter(e=>e.language===ll).length} 条记录，${bb.length} 处标记，${new Set(bb.map(b=>b.unitId)).size} 个单元。`));for(const ss of data.sections){const group=bb.filter(b=>b.sectionId===ss.id);if(group.length)scope.append(el('p','aid-scope-row',`${title(ss,ll)} · ${group.length} 处 / ${new Set(group.map(b=>b.unitId)).size} 单元`));}}scope.append(el('p','aid-review',`其余 ${context-covered} 单元没有词注标记。释义由代理对照本地书注整理；新增标记按限定章节中的完整词面定位，不代表逐处专家审核，也不声称已穷尽所有典故。`));});intro.append(scope);
      }
      root.append(intro);
      const direct=[...new Set((u[l]||[]).flatMap(p=>[...(p.noteIds||[]),...(p.segments||[]).filter(x=>x.type==='note').map(x=>x.noteId)]))].map(id=>data.notesById?.[id]||data.notesById?.[data.legacy?.noteAliasesByUnit?.[u.id]?.[id]]).filter(n=>n?.language===l);
      const noteArea=el('section','aid-note-links');noteArea.append(el('h3','','原书注'));
      if(direct.length)for(const n of direct)noteArea.append(button(`本段原书注 ${n.label||''}`,()=>{view.kind='note';view.note=n;view.noteOwner=u;render();}));else noteArea.append(el('p','aid-state','本段此语言没有直接引用的原书注。'));
      const chapter=el('details','aid-chapter-notes');chapter.append(el('summary','',`本章书注 · ${(s?.noteIds?.[l]||[]).length}`));
      chapter.addEventListener('toggle',()=>{if(!chapter.open||chapter.dataset.loaded)return;chapter.dataset.loaded='true';const list=el('div');chapter.append(list);let count=0;const ids=s.noteIds?.[l]||[];const more=button('继续显示本章书注',()=>add());const add=()=>{more.remove();for(const id of ids.slice(count,count+30)){const n=data.notesById[id];if(n)list.append(button(`本章书注 ${n.label||''}`,()=>{view.kind='note';view.note=n;view.noteOwner=u;render();}));}count+=30;if(count<ids.length)list.append(more);};add();});noteArea.append(chapter);root.append(noteArea);
      const order=s?.readingOrder?.[l]||[],index=order.indexOf(u.id),from=Math.max(0,index-view.before),to=Math.min(order.length,index+view.after+1);
      const context=el('section','aid-context');context.append(el('h3','','前后原文'),el('p','aid-position',`${l==='zh'?'中文':'English'} · ${title(s,l)} · 本段 ${index+1}/${order.length}`));
      if(index<0){context.append(el('p','aid-state','此单元未找到本语言原序，未猜配其他语言。'));root.append(context);finish();return;}
      const boundary=(direction)=>{
        context.append(el('p','aid-boundary',direction<0?'已到本章开头':'已到本章末尾'));
        const available=data.sections.filter(x=>x.readingOrder?.[l]?.length),si=available.findIndex(x=>x.id===s.id),next=available[si+direction];
        if(next){const id=direction<0?next.readingOrder[l].at(-1):next.readingOrder[l][0];context.append(button(`打开${direction<0?'上一':'下一'}章 · ${title(next,l)} · ${l==='zh'?'中文':'English'}`,()=>reader.openTarget({unitId:id,language:l},{reason:'阅读辅助跨章',focus:true})));}
      };
      if(from>0)context.append(button('再看前面 2 段',()=>{view.before+=2;render();}));else boundary(-1);
      for(let i=from;i<to;i++){
        const item=units.get(order[i]);if(!item)continue;const article=el('article','aid-context-unit');article.dataset.unitId=item.id;if(i===index)article.setAttribute('aria-current','true');
        article.append(el('p','aid-unit-label',`${i===index?'当前段':i<index?'前文':'后文'} · ${i+1}/${order.length} · ${l==='zh'?'中文':'English'}`));const body=el('div',`book-text aid-book-text ${l==='en'?'english-text':''}`);renderUnit(item,l,body);article.append(body,button('打开这一段',()=>reader.openTarget({unitId:item.id,language:l},{reason:'阅读辅助打开原段',focus:true})));context.append(article);
      }
      if(to<order.length)context.append(button('再看后面 2 段',()=>{view.after+=2;const y=root.scrollTop;render();root.scrollTop=y;}));else boundary(1);root.append(context);finish();
    }
    load();return {annotate,show,openNote,reset:()=>{view=null;root=null;},getStatus:()=>({status,error,valid:report?.valid.length||0,rejected:report?.rejected.length||0})};
  }
  window.ReadingAids=Object.freeze({init:create,validate,textOf,digest});
})();
