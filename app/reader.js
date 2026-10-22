'use strict';

(() => {
  const t=(en,zh)=>window.FoliotterI18n?.text(en,zh) ?? en;
  const params = new URLSearchParams(location.search);
  const importedBook = params.has('book');
  const bookId = params.get('book') || '';
  const productName = t("Foliotter", '书獭 · Foliotter');
  const dataset = params.get('dataset') === 'candidate' ? 'candidate' : 'active';
  const recordMode = params.get('records') || '';
  let store = null;
  let state = {};
  const uiLocale=()=>window.FoliotterI18n?.getLocale() || 'en';
  let language = 'en', preferredLanguage = 'en', secondaryLanguage = 'off', languageModel = null;
  let schema2 = false;
  let sections = [], sectionMap = new Map(), unitMap = new Map(), blockOwners = new Map(), noteOwners = new Map();
  let languageOrder = {zh:[],en:[]}, randomPool = [], pausedPosition = 0;
  let searchSession = {query:'',scope:'main',language:'all',limit:50,scroll:0};
  let searchIndex = [], indexReady = false, importPreview = null;
  let directoryLanguage = null, imageLanguage = null, renderSerial = 0, exportedNames = new Map(), handledHash = '';
  const $ = (id) => document.getElementById(id);
  const dom = {};
  const ids = ['today-button','today-number','history-button','sequence-details','total-count','unit-index','scope-label','record-button','record-indicator','load-state','reader','chapter-zh','chapter-en','current-number','unit-total','previous-button','next-button','random-button','favorite-button','content-type','source-button','alignment-notice','zh-content','en-content','original-language','original-content','notes-button','notes-count','related-button','related-status','search-indicator','footer-total','back-top','detail-panel','panel-context','panel-title','panel-close','panel-content','toast','contents-button','search-button','records-button','language-select','language-controls','chapter-notes-button','search-return','storage-notice','progress-label','dataset-label','random-total'];
  ids.forEach((id) => { dom[id] = $(id); });
  const mobilePanelMedia = window.matchMedia('(max-width:760px)');
  const panelBackground = [document.querySelector('.book-rail'), $('reading')];

  let data = null;
  let readingBytes = null, readingSha256 = null, readingAids = null, aidSession = null, readingDictionary = null;
  let alignmentIndex = null, alignmentLoadError = '', visibleComparison = null;
  // Context is a temporary reading surface, never a second persisted location.
  let contextState = null, contextModel = null, pageReader = null;
  const contextMotionMedia=window.matchMedia('(prefers-reduced-motion: reduce)');
  const contextAnimations=new Set();
  let contextNewIds=new Set(),contextMessage='',contextPlace='',contextSmoothScroll=false;
  // Chapter reading positions stay in this document; they are not translation pairs or records.
  let languageSession = null, languageSelection = null, languageReturnBusy = false;
  let units = [];
  let current = null;
  let panel = null;
  let returnFocus = null;
  let controller = null;
  let requestSerial = 0;
  let relatedPollTimer = null;
  let relatedRenderSignature = null;
  let scrollTimer = null;
  let toastTimer = null;
  let storageAvailable = true;
  let restoringScroll = false;
  const relatedByUnit = new Map();
  let recordSaveSerial=0;
  const recordNotice=message=>window.FoliotterRecordNotices?.text(message) || message;
  function refreshStorageNotice() {
    if(!store)return;
    storageAvailable=store.available;
    const message=store.notice?recordNotice(store.notice):recordMode==='session'?t('Isolated test session: records use session storage; saved local records remain untouched.','隔离验收会话：本页记录使用会话存储，不改本机正式记录。'):!storageAvailable?t('Records are saved only for this session. Export them in Backup & restore.','本次记录仅在会话中，请打开“备份与恢复”导出保存。'):'';
    dom['storage-notice'].hidden=!message;dom['storage-notice'].textContent=message;
  }
  async function persist() {
    if (!store || !current || pausedPosition) return false;
    const ok=await store.persist();refreshStorageNotice();return ok;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function button(text, className, action) {
    const element = node('button', className, text);
    element.type = 'button';
    if (action) element.addEventListener('click', action);
    return element;
  }

  function pad(number) { return String(number).padStart(2, '0'); }
  function languageLabel(lang = language) {
    if(!importedBook)return lang === 'zh' ? '中文' : 'English';
    try{return new Intl.DisplayNames([uiLocale()==='zh'?'zh-CN':'en'],{type:'language'}).of(data.metadata.language || 'und') || t("Original text", '原文');}
    catch(_){return t("Original text", '原文');}
  }
  function languageOptions() {return (languageModel?.available || ['en','zh']).map(lang=>[lang,importedBook?languageLabel(lang):lang==='en'?'English':'中文']);}
  function preferenceKey(){return `foliotter.reading-language.${data.metadata?.datasetId || bookId || 'legacy-20'}`;}
  function saveLanguagePreference(){
    if(recordMode==='readonly')return;
    try{(recordMode==='session'?sessionStorage:localStorage).setItem(preferenceKey(),JSON.stringify({primary:preferredLanguage,secondary:secondaryLanguage}));}catch(_){}
  }
  function rebuildRandomPool(){randomPool=languageModel.randomPool(preferredLanguage);dom['random-total'].textContent=randomPool.length;}
  function prepareLanguage(){
    languageModel=window.ReadingLanguage.create(data,{getGroup:id=>alignmentIndex?.getGroup(id)});
    let saved={};try{saved=JSON.parse((recordMode==='session'?sessionStorage:localStorage).getItem(preferenceKey()) || '{}');}catch(_){}
    preferredLanguage=languageModel.primary(saved.primary || 'en');language=preferredLanguage;
    secondaryLanguage=['en','zh'].includes(saved.secondary) && saved.secondary!==preferredLanguage?saved.secondary:'off';
    rebuildRandomPool();
  }
  function applyBookIdentity() {
    const title = importedBook ? recordNotice(data.metadata.title) || t("Untitled book", '未命名电子书') : t("The Red Book", '红书');
    document.querySelector('.workspace-brand').textContent=t("Foliotter", '书獭');
    document.querySelector('.book-title .title-zh').textContent=title;
    document.querySelector('.book-title .title-en').textContent=importedBook?productName:'The Red Book';
    document.querySelector('.book-author').textContent=importedBook?recordNotice(data.metadata.author) || t("Author not provided", '作者未标注'):t("C. G. JUNG", 'C. G. JUNG · 荣格');
    document.body.classList.toggle('imported-book',importedBook);
    if(!importedBook)return;
    $('reading-stage').setAttribute('aria-label',t("Original book text", '电子书原文'));
    for(const id of ['artwork-open','artwork-return','artwork-return-origin','reading-aids-open','context-toggle','language-choose','related-button','notes-button','chapter-notes-button'])$(id).hidden=true;
    dom['source-button'].textContent=t("Book information", '电子书信息');
    for(const lang of ['zh','en']){
      $(`${lang}-title`).replaceChildren(document.createTextNode(languageLabel()),node('span','',t("Imported book", '导入的电子书')));
      dom[`${lang}-content`].lang=data.metadata.language || 'und';
    }
    dom['language-select'].replaceChildren(...languageOptions().map(([value,label])=>{const option=node('option','',label);option.value=value;return option;}));
  }
  function unitById(id) { return unitMap.get(id) || unitMap.get(data?.legacy?.unitAliases?.[id]); }
  function dateKey() { return window.RedbookRecords.date(); }
  function formattedDate(value) {
    if (!value) return t("Time not provided", '时间未提供');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(uiLocale()==='zh'?'zh-CN':'en-US', {timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
  }
  function plain(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(plain).join('；');
    if (value && typeof value === 'object') return Object.entries(value).map(([key, text]) => `${key}：${plain(text)}`).join('；');
    return value == null ? '' : String(value);
  }
  function preview(unit) {
    return unit ? (unit[language]?.length ? unit[language] : unit.zh?.length ? unit.zh : unit.en || []).map((paragraph) => paragraph.text || '').join(' ').slice(0,65) : '';
  }
  function safeURL(value) {
    try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : null; }
    catch (_) { return null; }
  }
  function toast(message) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 2800);
  }

  function unitLanguage(unit, wanted = language) {
    if ((unit[wanted] || []).length || (unit.structure?.language === wanted)) return wanted;
    return unit.zh?.length || unit.structure?.language === 'zh' ? 'zh' : 'en';
  }
  function sectionTitle(section, lang = language) { return section?.title?.[lang] || section?.title?.zh || section?.title?.en || t("Chapter", '阅读章节'); }
  function currentSection() { return sectionMap.get(current?.sectionId); }
  function canReadBoth(section=currentSection()) {
    return !importedBook && schema2 && section?.chapterMatch?.status==='verified' && ['zh','en'].every(lang=>section.readingOrder?.[lang]?.length);
  }
  function comparisonFor(unit=current) {return importedBook?null:languageModel?.group(unit) || null;}
  function displayedUnits() {
    return visibleComparison?[...new Map([...visibleComparison.zh,...visibleComparison.en].map(unit=>[unit.id,unit])).values()]:[current];
  }
  function visibleNotes() {
    return [...new Map(displayedUnits().flatMap(unit=>allNotes(unit)).map(note=>[note.id,note])).values()];
  }
  function comparisonDifferences() {
    return [plain(current?.differences || current?.alignment?.differences || []),
      plain(comparisonFor()?.review?.versionDifferences || [])].filter(Boolean).join('；');
  }
  function otherLanguageEntry(other, text) {
    const order=currentSection()?.readingOrder?.[other] || [];
    return button(text || (order.length?t(`Open this chapter in ${other==='en'?'English':'中文'}`, `打开本章${other==='en'?'英文':'中文'}`):t(`Open ${other==='en'?'English':'中文'} contents`, `打开${other==='en'?'英文':'中文'}目录`)),'text-button',()=>{
      if(order.length && canReadBoth())openPanel('language-chapter');
      else{directoryLanguage=other;openPanel('contents');}
    });
  }
  function renderReadingColumns() {
    const view=languageModel.columns(current,language,secondaryLanguage);
    visibleComparison=importedBook?null:view.comparison;
    const spread=document.querySelector('.bilingual');
    spread.classList.toggle('single-language',!visibleComparison);spread.dataset.primaryLanguage=language;
    document.querySelector('.bilingual').dataset.alignmentGroup=visibleComparison?.id || '';
    for(const lang of ['zh','en']){
      const container=dom[`${lang}-content`], column=container.closest('.language-column');
      column.hidden=lang!==language && !visibleComparison;column.style.order=lang===language?'0':'1';container.replaceChildren();
      if(column.hidden)continue;
      const sourceUnits=visibleComparison?.[lang] || (lang===language?[current]:[]);
      if(!sourceUnits.length){column.hidden=true;continue;}
      for(const unit of sourceUnits){
        const wrapper=node('section','parallel-source-unit');wrapper.dataset.readingUnit=unit.id;wrapper.dataset.readingLanguage=lang;
        if(unit===sourceUnits[0] && (visibleComparison || unit.id!==current.id || lang!==language)){
          const marker=node('div','parallel-unit-location');
          const order=sectionMap.get(unit.sectionId)?.readingOrder?.[lang] || [];
          const first=order.indexOf(unit.id)+1,last=order.indexOf(sourceUnits.at(-1).id)+1;
          marker.append(node('span','',t(`Chapter passage ${first}${last!==first?`–${last}`:''}${lang===language?' · Reading now':''}`, `本章第 ${first}${last!==first?`–${last}`:''} 项${lang===language?' · 当前阅读':''}`)));
          if(lang!==language)marker.append(button(t(`Continue here in ${lang==='en'?'English':'中文'}`, `从此${lang==='en'?'英文':'中文'}段继续`),'text-button',()=>showUnit(unit.id,{language:lang,reason:t("Continue from paired passage", '从对照原段继续'),focus:true})));
          wrapper.append(marker);
        }
        const body=node('div','parallel-unit-body');
        renderLanguage(unit,lang,body);
        wrapper.append(body);container.append(wrapper);
      }
    }
    renderInlineContext();
    pageReader?.refresh();
  }
  function contextWindow() {
    if(!current || !window.ReadingContext)return null;
    if(!contextModel)contextModel=window.ReadingContext.create({
      getUnit:unitById,getSection:id=>sectionMap.get(id),getGroup:id=>secondaryLanguage===(language==='en'?'zh':'en')?alignmentIndex?.getGroup(id):null
    });
    return contextModel.window(contextState || {unitId:current.id,language});
  }
  function captureReadingSurface() {
    const blocks=[...dom.reader.querySelectorAll('[data-source-paragraph]')];
    const visible=blocks.filter(el=>el.getBoundingClientRect().bottom>70 && el.getBoundingClientRect().top<innerHeight);
    const target=visible.find(el=>el.closest('[data-reading-unit]')?.dataset.readingLanguage===language) || visible[0];
    const owner=target?.closest('[data-reading-unit]');
    return target && owner?{blockId:target.dataset.sourceParagraph,unitId:owner.dataset.readingUnit,
      language:owner.dataset.readingLanguage,top:target.getBoundingClientRect().top}:null;
  }
  function findReadingSurface(value) {
    if(!value)return null;
    return [...dom.reader.querySelectorAll('[data-source-paragraph]')].find(el=>{
      const owner=el.closest('[data-reading-unit]');
      return el.dataset.sourceParagraph===value.blockId && owner?.dataset.readingUnit===value.unitId && owner.dataset.readingLanguage===value.language;
    });
  }
  function stopContextMotion() {
    for(const animation of contextAnimations)animation.cancel();
    contextAnimations.clear();
    if(contextSmoothScroll){contextSmoothScroll=false;window.scrollTo({top:scrollY,left:scrollX,behavior:'instant'});}
  }
  function animateContext(elements,kind='reveal',distance=0) {
    if(contextMotionMedia.matches)return;
    elements.filter(Boolean).forEach((element,index)=>{
      if(!element.animate)return;
      const frames=kind==='continuity'
        ?[{transform:`translateY(${distance}px)`},{transform:'translateY(0)'}]
        :kind==='origin'
        ?[{backgroundColor:'rgba(163,43,34,.13)'},{backgroundColor:'rgba(163,43,34,0)'}]
        :[{opacity:.35,transform:'translateY(6px)',clipPath:'inset(0 0 12px 0)'},{opacity:1,transform:'translateY(0)',clipPath:'inset(0)'}];
      const animation=element.animate(frames,{duration:kind==='origin'?600:kind==='continuity'?300:240,
        delay:kind==='origin'?0:Math.min(index*35,70),easing:'cubic-bezier(.16,1,.3,1)'});
      contextAnimations.add(animation);
      animation.finished.then(()=>{contextAnimations.delete(animation);if(kind==='continuity')updateContextRoute();},()=>contextAnimations.delete(animation));
    });
  }
  function contextInset() {
    return contextState?$('context-navigation').getBoundingClientRect().height+(pageReader?.contextOffset() || 0)+16:24;
  }
  function scrollToContext(target,{smooth=true,focus=true}={}) {
    if(!target)return;
    stopContextMotion();
    contextSmoothScroll=smooth && !contextMotionMedia.matches;
    window.scrollTo({top:Math.max(0,scrollY+target.getBoundingClientRect().top-contextInset()),
      behavior:contextSmoothScroll?'smooth':'instant'});
    if(focus){target.tabIndex=-1;target.focus({preventScroll:true});}
    updateContextRoute();
  }
  function updateContextRoute() {
    if(!contextState)return;
    const origin=document.querySelector('.bilingual'),after=$('context-after');
    const probe=Math.max(contextInset()+40,innerHeight*.4);
    const place=origin.getBoundingClientRect().top>probe?'before':after.getBoundingClientRect().top<=probe?'after':'origin';
    if(contextPlace===place)return;
    contextPlace=place;
    for(const [part,id]of [['before','context-show-before'],['origin','context-origin'],['after','context-show-after']]){
      const control=$(id);
      if(part===place)control.setAttribute('aria-current','location');else control.removeAttribute('aria-current');
    }
  }
  function expandContext(direction='both') {
    stopContextMotion();
    ++renderSerial;restoringScroll=false;
    const first=!contextState,origin=document.querySelector('.bilingual'),surface=first?captureReadingSurface():null;
    const originTop=origin.getBoundingClientRect().top,top=scrollY;
    const previous=contextWindow(),previousIds=new Set([...(previous?.before || []),...(previous?.after || [])].map(row=>row.id));
    if(first){savePosition();contextState={unitId:current.id,language,before:0,after:0};}
    if(direction==='both'||direction==='before')contextState.before+=2;
    if(direction==='both'||direction==='after')contextState.after+=2;
    const view=contextWindow();
    contextNewIds=new Set([...view.before,...view.after].filter(row=>!previousIds.has(row.id)).map(row=>row.id));
    contextMessage=first?t("Context expanded. Your original passage remains here.", '前后文已展开，原段仍在这里。'):t(`Added ${contextNewIds.size} groups ${direction==='before'?'before':'after'}, marked “Just expanded”.`, `本次新增 ${contextNewIds.size} 组${direction==='before'?'前文':'后文'}，标为「刚展开」。`);
    renderInlineContext();
    const added=[...dom.reader.querySelectorAll('[data-context-new]')];
    if(first){
      // Compensate the inserted front matter before paint: the original text
      // remains at the same screen position instead of jumping several pages.
      const point=findReadingSurface(surface) || origin;
      const previousTop=surface?surface.top:originTop;
      // Preserve a long paragraph's already-visible middle. A paragraph below
      // the controls moves only into the reading area, with its motion visible.
      const targetTop=surface && previousTop<0?previousTop:
        Math.min(Math.max(contextInset()+24,previousTop),Math.max(contextInset()+224,innerHeight*.4));
      window.scrollTo({top:Math.max(0,scrollY+point.getBoundingClientRect().top-targetTop),behavior:'instant'});
      $('context-origin').focus({preventScroll:true});
      if(Math.abs(previousTop-targetTop)>1)animateContext([origin],'continuity',previousTop-targetTop);
      animateContext([$('context-navigation')]);
      animateContext([$('context-origin-label')],'origin');
    }else{
      window.scrollTo({top,behavior:'instant'});
      scrollToContext(added[0],{smooth:true});
    }
    animateContext(added);
    updateContextRoute();
  }
  function returnToContextOrigin() {
    scrollToContext($('context-origin-label'));
    animateContext([$('context-origin-label')],'origin');
  }
  function collapseContext() {
    stopContextMotion();++renderSerial;restoringScroll=false;
    contextNewIds.clear();contextMessage='';contextPlace='';
    contextState=null;renderInlineContext();
    const origin=document.querySelector('.bilingual');
    scrollToContext(origin,{smooth:false});
    animateContext([origin],'origin');
  }
  function renderContextRow(row, side) {
    const article=node('article','context-row');article.dataset.contextGroup=row.id;
    if(contextNewIds.has(row.id))article.dataset.contextNew='true';
    const source=row[language],order=currentSection().readingOrder[language];
    const first=order.indexOf(source[0].id)+1,last=order.indexOf(source.at(-1).id)+1;
    const heading=node('header','context-row-heading');
    const title=node('h3','',t(`${side==='before'?'Before':'After'} · Passage ${first}${first!==last?`–${last}`:''}`, `${side==='before'?'前文':'后文'} · 第 ${first}${first!==last?`–${last}`:''} 项`));
    if(contextNewIds.has(row.id))title.append(node('span','context-new-label',t("Just expanded", '刚展开')));
    heading.append(title,
      button(t("Continue here", '从这里继续读'),'text-button',()=>showUnit(source[0].id,{language,reason:t("Continue from context", '从展开的前后文继续'),focus:true})));
    article.append(heading);
    const grid=node('div','context-row-columns');
    const other=language==='en'?'zh':'en',contextLanguages=secondaryLanguage===other && row[other]?.length?[language,other]:[language];
    grid.classList.toggle('single-language',contextLanguages.length===1);
    for(const lang of contextLanguages){
      const column=node('section','context-column');
      const label=node('div','context-language-label');
      label.append(node('span','',lang==='zh'?'中文':'English'));
      if(lang!==language && row[lang].length)label.append(button(t(`Continue here in ${lang==='en'?'English':'中文'}`, `从此${lang==='en'?'英文':'中文'}段继续`),'text-button',()=>showUnit(row[lang][0].id,{language:lang,reason:t("Continue from paired context", '从展开的对照原段继续'),focus:true})));
      column.append(label);

      for(const unit of row[lang]){
        const wrapper=node('section','parallel-source-unit');wrapper.dataset.readingUnit=unit.id;wrapper.dataset.readingLanguage=lang;
        const body=node('div',`book-text parallel-unit-body${lang==='en'?' english-text':''}`);body.lang=lang==='zh'?'zh-CN':'en';
        renderLanguage(unit,lang,body,'context');wrapper.append(body);column.append(wrapper);
      }
      grid.append(column);
    }
    article.append(grid);
    const differences=plain(row.review?.versionDifferences || row[language].flatMap(u=>u.differences || u.alignment?.differences || []));
    if(differences)article.append(node('p','context-differences',t(`Edition differences | ${differences}`, `版本差异｜${differences}`)));
    return article;
  }
  function contextBoundary(side) {
    const root=node('div','context-boundary');
    root.append(node('p','',side==='before'?t("Start of this chapter.", '已到本章开头。'):t("End of this chapter.", '已到本章结尾。')));
    const section=currentSection(),order=languageOrder[language],ids=section.readingOrder[language];
    const boundary=side==='before'?order.indexOf(ids[0])-1:order.indexOf(ids.at(-1))+1;
    const next=unitById(order[boundary]);
    if(next && next.sectionId!==section.id){
      const name=sectionTitle(sectionMap.get(next.sectionId));
      root.append(button(t(`${side==='before'?'Previous chapter':'Next chapter'}: ${name}`, `${side==='before'?'继续上一章':'继续下一章'}：${name}`),'text-button',()=>showUnit(next.id,{language,reason:t("Continue to adjacent chapter", '从前后文继续相邻章节'),focus:true})));
    }
    return root;
  }
  function renderInlineContext() {
    const before=$('context-before'),after=$('context-after'),toggle=$('context-toggle');
    if(!before || !after || !toggle)return;
    const view=contextWindow(),expanded=Boolean(contextState && view);
    pageReader?.setContext(expanded);
    toggle.disabled=!view;toggle.setAttribute('aria-expanded',String(expanded));
    toggle.textContent=expanded?t("Collapse context", '收起前后文'):t("Show context", '展开前后文');
    dom.reader.classList.toggle('context-is-expanded',expanded);
    for(const id of ['context-navigation','context-origin-label','context-before','context-after'])$(id).hidden=!expanded;
    before.replaceChildren();after.replaceChildren();
    if(!expanded)return;
    $('context-status').textContent=contextMessage || t(`Expanded in ${language==='zh'?'Chinese':'English'} source order. Use the controls to browse before or after.`, `按${language==='zh'?'中文':'英文'}原序展开，点击导航查看前文或后文。`);
    $('context-before-count').textContent=t(`Before · ${view.before.length} groups`, `前文 ${view.before.length} 组`);
    $('context-after-count').textContent=t(`After · ${view.after.length} groups`, `后文 ${view.after.length} 组`);
    $('context-show-before').disabled=!view.before.length;
    $('context-show-after').disabled=!view.after.length;
    const more=side=>{
      const control=button(side==='before'?t("More before ↑", '再展开前文 ↑'):t("More after ↓", '再展开后文 ↓'),'context-more',()=>expandContext(side));
      control.id=`context-more-${side}`;return control;
    };
    before.append(view.hasBefore?more('before'):contextBoundary('before'));
    for(const row of view.before)before.append(renderContextRow(row,'before'));
    for(const row of view.after)after.append(renderContextRow(row,'after'));
    after.append(view.hasAfter?more('after'):contextBoundary('after'));
    const end=node('div','context-end');
    end.append(button(t("Back to your original passage ↑", '回到感兴趣的这一段 ↑'),'text-button',returnToContextOrigin),button(t("Collapse context", '收起前后文'),'text-button',collapseContext));
    after.append(end);
    updateContextRoute();
  }
  async function loadAlignment() {
    if(importedBook || !schema2 || dataset!=='active' || !window.ReadingAlignment)return;
    try{
      const response=await fetch('/data/reading-alignment.json',{cache:'no-cache'});
      if(!response.ok)throw Error(t(`Pairing data returned ${response.status}`, `对照资料返回 ${response.status}`));
      const payload=await response.json();
      alignmentIndex=window.ReadingAlignment.buildIndex(data,payload,readingSha256);
      if(alignmentIndex.error)throw Error(alignmentIndex.error);
      document.documentElement.dataset.reviewedAlignmentGroups=String(alignmentIndex.groups.size);
      document.documentElement.dataset.rejectedAlignmentGroups=String(alignmentIndex.rejected.length);
    }catch(error){alignmentIndex=null;alignmentLoadError=error.message;}
  }
  function captureLanguagePosition() {
    return {anchor:anchor(),restore:window.RedbookReader?.captureViewport() || null};
  }
  function validLanguagePosition(position,lang) {
    const value=position?.anchor,unit=value && unitById(value.unitId);
    if(!value || !unit || !languageSession || languageSession.dataset!==dataset || languageSession.datasetId!==data.metadata?.datasetId || unit.sectionId!==languageSession.sectionId || value.language!==lang || unitLanguage(unit,lang)!==lang)return false;
    if(value.blockId){const owner=blockOwners.get(value.blockId) || blockOwners.get(data.legacy?.blockAliases?.[value.blockId]);if(!owner || owner.unitId!==unit.id || owner.language!==lang)return false;}
    return true;
  }
  function rememberLanguagePosition() {
    if(languageSession && current?.sectionId===languageSession.sectionId && !restoringScroll && !pausedPosition)languageSession.positions[language]=captureLanguagePosition();
  }
  function updateLanguageTools() {
    if(!current || !languageModel)return;
    const options=languageOptions();
    dom['language-select'].replaceChildren(...options.map(([value,label])=>{const option=node('option','',label);option.value=value;return option;}));
    dom['language-select'].value=language;dom['language-select'].disabled=options.length===1;
    const other=language==='en'?'zh':'en',comparison=comparisonFor(),secondary=$('secondary-language-select');
    const off=node('option','',t('Off','关闭'));off.value='off';
    secondary.replaceChildren(off);
    if(options.length>1){const option=node('option','',other==='en'?'English':'中文');option.value=other;secondary.append(option);}
    secondary.value=secondaryLanguage===other?other:'off';secondary.disabled=options.length<2;
    $('comparison-controls').hidden=options.length<2;
    $('language-choose').hidden=true;
    const info=$('language-reading-status');
    info.textContent=visibleComparison?t('Verified source pairing · no automatic translation','已核对的原段对应 · 不自动翻译'):secondaryLanguage!=='off' && !comparison?t('No verified counterpart for this passage. Showing the available text.','本段没有已核对应段，仅显示现有原文。'):t('Original text · single language','原文 · 单语阅读');
  }
  function readLanguage(wanted) {
    if(!current || !languageModel.available.includes(wanted) || languageReturnBusy)return;
    preferredLanguage=wanted;if(secondaryLanguage!=='off')secondaryLanguage=wanted==='en'?'zh':'en';saveLanguagePreference();rebuildRandomPool();
    if(wanted===language){updateLanguageTools();return;}
    const comparison=comparisonFor();
    if(comparison){
      const unit=comparison[wanted].find(item=>item.id===current.id) || comparison[wanted][0];
      showUnit(unit.id,{language:wanted,reason:t("Continue from paired passage", '从对应原段继续'),focus:true});return;
    }
    const saved=languageSession?.positions[wanted];
    if(saved && canReadBoth()){
      if(!validLanguagePosition(saved,wanted)){delete languageSession.positions[wanted];updateLanguageTools();toast(t("That reading position is no longer available. Choose a passage from this chapter.", '刚才的阅读位置已失效，请从本章列表重选。'));return;}
      rememberLanguagePosition();languageReturnBusy=true;updateLanguageTools();
      const ok=saved.restore?saved.restore({focus:true,reason:t("Return to chapter reading", '同章对读返回')}):window.RedbookReader.restoreAnchor(saved.anchor,{focus:true,reason:t("Return to chapter reading", '同章对读返回')});
      if(!ok){delete languageSession.positions[wanted];toast(t("That reading position is unavailable. Choose a passage from this chapter.", '刚才的阅读位置暂不可用，请从本章列表重选。'));}
      requestAnimationFrame(()=>requestAnimationFrame(()=>{languageReturnBusy=false;updateLanguageTools();}));return;
    }
    if(canReadBoth())openPanel('language-chapter');else{directoryLanguage=wanted;openPanel('contents');}
  }
  function chooseLanguageUnit(id,other) {
    const unit=unitById(id),selection=languageSelection;
    if(!unit || !canReadBoth() || !currentSection().readingOrder[other].includes(id) || unitLanguage(unit,other)!==other){toast(t("This position is unavailable. Choose another passage in the chapter.", '该位置暂不可用，请重新选择本章阅读位置。'));return;}
    if(!languageSession)languageSession={dataset,datasetId:data.metadata?.datasetId,sectionId:current.sectionId,positions:{}};
    languageSession.positions[language]=selection?.sectionId===current.sectionId && selection.language===language?selection.position:captureLanguagePosition();
    showUnit(id,{language:other,reason:t("Other language in this chapter", '同章另一语言'),focus:true});
  }
  function scopeKind(section) { return section?.kind === 'support' ? 'support' : section?.kind === 'main' ? 'main' : 'extra'; }
  function anchor() {
    if (!current) return null;
    const pageAnchor=pageReader?.getAnchor();
    if(pageAnchor)return {unitId:current.id,language,...pageAnchor,legacyScrollY:0};
    const container = dom[`${language}-content`];
    const owner=[...container.querySelectorAll('[data-reading-unit]')].find(el=>el.dataset.readingUnit===current.id);
    const blocks = [...(owner || container).querySelectorAll('[data-source-paragraph]')];
    const item = blocks.find(el => el.getBoundingClientRect().bottom > 70) || blocks.at(-1);
    const rect = item?.getBoundingClientRect();
    return {unitId:current.id,language,...(item ? {blockId:item.dataset.sourceParagraph,offsetRatio:Math.min(1,Math.max(0,(70-rect.top)/Math.max(1,rect.height)))} : {offsetRatio:0}),legacyScrollY:Math.max(0,Math.round(scrollY))};
  }
  function savePosition() {
    if (current && !contextState && !restoringScroll && !pausedPosition && store) {
      const value=anchor();state.positions[current.id]=value;state.current=value;rememberLanguagePosition();
    }
  }
  function rememberVisit(unit, reason) {
    const at=new Date().toISOString(),last=state.history[0];
    if (!last || last.id !== unit.id) state.history.unshift({id:unit.id,at,reason});
    state.history=state.history.slice(0,100);
    const previous=state.visited[unit.id];state.visited[unit.id]={firstAt:previous?.firstAt || at,lastAt:at};
  }
  function updateProgress() {
    if (!current) return;
    const section=currentSection(), category=scopeKind(section);
    const order=languageOrder[language].filter(id=>scopeKind(sectionMap.get(unitById(id)?.sectionId))===category && (!schema2 || unitById(id).kind==='prose' || unitById(id).kind==='table'));
    const i=order.indexOf(current.id), visited=order.filter(id=>state.visited[id]).length;
    const label=({main:t("Main text", '正文'),extra:t("Original text & appendices", '原作与附录'),support:t("Supporting material", '资料')})[category];
    dom['progress-label'].textContent=order.length ? t(`${languageLabel()} ${label} · ${i<0?'Image or heading':order.length===1?'One passage':`${Math.round(i/(order.length-1)*100)}%`} · Visited ${visited}/${order.length}`, `${languageLabel()}${label} · 当前位置 ${i<0?'图页或标题':order.length===1?'仅1项':`${Math.round(i/(order.length-1)*100)}%`} · 已访问 ${visited}/${order.length}`) : t("No text progress for this section", '此范围暂无文字进度');
  }
  function renderIndex() {
    const box=dom['unit-index'];box.replaceChildren();
    const order=schema2 ? currentSection()?.readingOrder?.[language] || [] : units.map(u=>u.id);
    if(schema2) {
      box.classList.add('chapter-index');
      box.append(node('p','rail-chapter',sectionTitle(currentSection())));
      const offset=Math.floor(Math.max(0,order.indexOf(current.id))/12)*12;
      for(const id of order.slice(offset,offset+12)) {
        const unit=unitById(id), item=button(String(order.indexOf(id)+1),'',()=>showUnit(id,{language,reason:t("Read from contents", '目录阅读')}));
        item.dataset.unitId=id; item.setAttribute('aria-label',t(`Chapter passage ${order.indexOf(id)+1}: ${preview(unit).slice(0,24)}`, `本章第${order.indexOf(id)+1}项：${preview(unit).slice(0,24)}`));box.append(item);
      }
      box.append(button(t("Open full contents", '打开完整目录'),'rail-directory-link',()=>openPanel('contents')));
    } else for(const unit of units) {
      const item=button(pad(unit.order),'',()=>showUnit(unit.id,{reason:t("Read in sequence", '顺序核对')}));item.dataset.unitId=unit.id;
      item.setAttribute('aria-label',t(`Passage ${unit.order}: ${preview(unit).slice(0,20)}`, `阅读单元 ${unit.order}：${preview(unit).slice(0,20)}`));box.append(item);
    }
    updateIndex();
  }
  function updateIndex() {
    dom['unit-index'].querySelectorAll('[data-unit-id]').forEach(item=>{
      item.setAttribute('aria-current',String(item.dataset.unitId===current?.id));
      item.classList.toggle('is-favorite',state.favorites.includes(item.dataset.unitId));
    });
  }
  function imageNode(id, inline=false, alt='', owner=current) {
    const image=data.imagesById?.[id];
    if(!image)return node('span','image-error',t("Image unavailable", '图片资源暂不可用'));
    const url=!importedBook && dataset==='candidate' ? (image.candidatePath && '/candidate/'+image.candidatePath.split('/').map(encodeURIComponent).join('/')) : image.localUrl;
    const prefix=importedBook?`/api/library/${encodeURIComponent(bookId)}/assets/`:dataset==='candidate'?'/candidate/assets/':'/data/';
    if(!url || !url.startsWith(prefix) || url.includes('..') || url.includes('\\'))return node('span','image-error',t("Image path unavailable", '图片路径暂不可用'));
    const filename=(image.file || id).split('/').at(-1), sourceLanguage=importedBook?languageLabel():(image.bookId || '').startsWith('zh-')?'中文':t("English", '英文');
    const img=node('img',inline?'inline-source-image':'source-image');img.src=url;img.alt=alt || t(`Image from ${importedBook?data.metadata.title:'The Red Book'}: ${filename}`, `《${importedBook?data.metadata.title:'红书'}》中的图像：${filename}`);img.loading='lazy';
    if(image.width && image.height){img.width=image.width;img.height=image.height;}
    img.addEventListener('error',()=>{img.replaceWith(node('span','image-error',t(`Image unavailable: ${filename}`, `图片暂不可用：${filename}`)));});
    if(inline)return img;
    const fig=node('figure','book-image');fig.dataset.sourceParagraph=image.occurrences?.find(o=>o.sectionId===owner?.sectionId)?.blockId || id;fig.tabIndex=-1;
    fig.append(img,node('figcaption','',t(`Image from supplied ${sourceLanguage} book · ${filename}`, `所提供${sourceLanguage}电子书图像 · ${filename}`)));return fig;
  }
  function appendSegments(parent,segments,lang,owner=current,preview=false) {
    for(const segment of segments || []) {
      if(segment.type==='note') {
        const ref=button(segment.label || t("Note", '注'),'note-ref',()=>preview?readingAids?.openNote(segment.noteId,owner):openPanel('notes',segment.noteId));ref.dataset.noteId=segment.noteId || '';ref.setAttribute('aria-label',t(`View ${lang==='en'?'English':'Chinese'} note ${segment.label || ''}`, `查看${lang==='en'?'英文':'中文'}书注 ${segment.label || ''}`));parent.append(ref);
      } else if(segment.type==='image') parent.append(imageNode(segment.imageId,true,segment.alt));
      else parent.append(document.createTextNode(segment.text || ''));
    }
  }
  function paragraphNode(paragraph,lang,tag='p',owner=current,preview=false) {
    const p=node(tag);p.dataset.sourceParagraph=paragraph.id || '';if(!preview)p.id=`block-${paragraph.id}`;p.tabIndex=-1;p.lang=importedBook?(paragraph.language || data.metadata.language || 'und'):lang==='zh'?'zh-CN':lang;
    if('segments' in paragraph)appendSegments(p,paragraph.segments,lang,owner,preview);else p.textContent=paragraph.text || '';if(!preview || preview==='context')readingAids?.annotate(p,paragraph,lang,owner);return p;
  }
  function renderParagraphs(paragraphs,container,lang) {container.replaceChildren();for(const p of paragraphs || [])container.append(paragraphNode(p,lang));}
  function renderLanguage(unit,lang,targetContainer=null,preview=false) {
    const container=targetContainer || dom[`${lang}-content`], paragraphs=unit[lang] || [], map=new Map(paragraphs.map(p=>[p.id,p])), used=new Set(), structure=unit.structure?.language===lang?unit.structure:null;
    container.replaceChildren();
    if(structure?.rows) {
      const wrap=node('div','table-scroll');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',t("Original table; scroll horizontally", '原书表格，可横向滚动'));
      const table=node('table','source-table'),caption=node('caption','',t("Original table", '原书结构表格'));table.append(caption);
      const body=node('tbody');for(const row of structure.rows){const tr=node('tr');for(const cell of row.cells){const td=node('td');td.rowSpan=cell.rowSpan || 1;td.colSpan=cell.colSpan || 1;for(const id of cell.paragraphIds || []){if(map.has(id)){td.append(paragraphNode(map.get(id),lang,'p',unit,preview));used.add(id);}}tr.append(td);}body.append(tr);}table.append(body);wrap.append(table);container.append(wrap);
    } else if(structure?.items) {
      for(const item of structure.items) {
        if(item.type==='paragraph' && map.has(item.paragraphId)){container.append(paragraphNode(map.get(item.paragraphId),lang,'p',unit,preview));used.add(item.paragraphId);}
        else if(item.imageId){container.append(imageNode(item.imageId,false,'',unit));for(const id of item.captionParagraphIds || [])if(map.has(id)){container.append(paragraphNode(map.get(id),lang,'p',unit,preview));used.add(id);}}
      }
    }
    for(const p of paragraphs)if(!used.has(p.id)){
      const imageOnly=importedBook && p.segments?.some(s=>s.type==='image') && p.segments.every(s=>s.type==='image' || !s.text?.trim());
      if(imageOnly){for(const segment of p.segments.filter(s=>s.type==='image')){const figure=imageNode(segment.imageId,false,segment.alt,unit);figure.dataset.sourceParagraph=p.id;container.append(figure);}}
      else container.append(paragraphNode(p,lang,unit.kind==='heading'?'h3':'p',unit,preview));
    }
    if(importedBook && !structure?.items && unit.kind==='image' && !paragraphs.some(p=>p.segments?.some(s=>s.type==='image')))for(const id of unit.imageIds || [])container.append(imageNode(id,false,'',unit));
  }
  function resolveNote(id,unit=current) {return data.notesById?.[id] || data.notesById?.[data.legacy?.noteAliasesByUnit?.[unit?.id]?.[id]] || [...(unit?.notes || []),...(unit?.chapterNotes || [])].find(n=>n.id===id);}
  function allNotes(unit=current) {
    if(!schema2)return [...(unit?.notes || []),...(unit?.chapterNotes || [])];
    return [...new Set([...(unit?.noteIds || []),...(unit?.chapterNoteIds || [])])].map(id=>resolveNote(id,unit)).filter(Boolean);
  }
  function hashFor(a) {const q=new URLSearchParams({unit:a.unitId,lang:a.language || language});if(a.blockId)q.set('block',a.blockId);if(a.noteId)q.set('note',a.noteId);return '#'+q;}
  function readHash() {const q=new URLSearchParams(location.hash.slice(1));return q.has('unit')?{unitId:q.get('unit'),language:['en','zh'].includes(q.get('lang'))?q.get('lang'):preferredLanguage,blockId:q.get('block') || undefined,noteId:q.get('note') || undefined}:null;}
  function saveHistoryContext() {if(current)history.replaceState({anchor:anchor(),search:{...searchSession},panel:panel==='search'?'search':null},'',location.href);}
  function restoreView(value,{focus=false,viewport=null}={}) {
    stopContextMotion();
    const serial=++renderSerial;restoringScroll=true;
    requestAnimationFrame(()=>{
      if(serial!==renderSerial)return;
      const id=value?.blockId,alias=data.legacy?.blockAliases?.[id];
      const target=id && [...dom.reader.querySelectorAll('[data-source-paragraph]')].find(el=>el.dataset.sourceParagraph===id || el.dataset.sourceParagraph===alias || data.legacy?.blockAliases?.[el.dataset.sourceParagraph]===id);
      if(pageReader?.restore(value,viewport?.page)){
        window.scrollTo({top:0,left:0,behavior:'instant'});
        if(focus)(target || dom['chapter-zh']).focus({preventScroll:true});
        requestAnimationFrame(()=>{if(serial===renderSerial)restoringScroll=false;});return;
      }
      const exact=viewport && viewport.unitId===current?.id && viewport.language===language && viewport.width===document.documentElement.clientWidth && viewport.height===innerHeight && viewport.readerWidth===dom.reader.offsetWidth && viewport.readerHeight===dom.reader.scrollHeight;
      const surface=findReadingSurface(viewport?.surface);
      if(exact || viewport?.top===0){window.scrollTo({top:exact?viewport.top:0,left:exact?viewport.left:0,behavior:'instant'});if(focus)(target || dom['chapter-zh']).focus({preventScroll:true});}
      else if(surface){window.scrollTo({top:Math.max(0,scrollY+surface.getBoundingClientRect().top-viewport.surface.top),behavior:'instant'});if(focus)surface.focus({preventScroll:true});}
      else if(target){const y=scrollY+target.getBoundingClientRect().top-70+(Number(value.offsetRatio)||0)*target.getBoundingClientRect().height;window.scrollTo({top:Math.max(0,y),behavior:'instant'});if(focus)target.focus({preventScroll:true});}
      else {window.scrollTo({top:Number(value?.legacyScrollY)||0,behavior:'instant'});if(focus)dom['chapter-zh'].focus({preventScroll:true});if(id)toast(t("This text position is unavailable. The original passage is open.", '此块定位暂不可用，已打开原单元。'));}
      requestAnimationFrame(()=>{if(serial===renderSerial)restoringScroll=false;});
    });
  }
  function showUnit(id,options={}) {
    const navigationStarted=performance.now();
    const unit=unitById(id);if(!unit){toast(t("This reading position does not exist. Choose from contents.", '此阅读位置不存在，请从目录选择。'));return false;}
    stopContextMotion();contextNewIds.clear();contextMessage='';contextPlace='';
    readingDictionary?.beforeNavigation();
    const {reason=t("Reading", '阅读'),restore=false,initial=false,noHistory=false,blockId,noteId,focus=false}=options;
    if(!initial){savePosition();if(!noHistory)saveHistoryContext();}
    if(languageSession && unit.sectionId!==languageSession.sectionId)languageSession=null;
    closePanel(false);current=unit;language=unitLanguage(unit,options.language || language);directoryLanguage=null;
    if(secondaryLanguage!=='off')secondaryLanguage=language==='en'?'zh':'en';
    contextState=options.contextSnapshot?.unitId===unit.id && options.contextSnapshot.language===language?{...options.contextSnapshot}:null;
    state.current={unitId:unit.id,language};rememberVisit(unit,reason);
    if(!unitById(state.today.id))state.today={date:dateKey(),id:unitById('lp-001')?.id || randomPool[0] || unit.id};
    const section=currentSection(), local=section?.readingOrder?.[language] || units.map(u=>u.id), index=local.indexOf(unit.id);
    dom['chapter-zh'].textContent=sectionTitle(section,language) || unit.chapter?.[language] || t("The Red Book", '红书');
    if(!schema2)dom['chapter-zh'].textContent=unit.chapter?.[language] || t("Liber Primus", '第一卷');
    dom['chapter-en'].textContent=importedBook?'':section?.title?.en || unit.chapter?.en || '';
    dom['current-number'].textContent=pad(Math.max(0,index)+1);dom['unit-total'].textContent=`/ ${local.length}`;
    dom['today-number'].textContent=state.today.date===dateKey()?t("Opened", '已领取'):t("Not opened", '待领取');
    dom['content-type'].textContent=importedBook?t("Original local book text", '本机电子书原文'):({author:t("Jung’s original work", '荣格原作'),'quoted-by-author':t("Text quoted by Jung", '荣格引用的原文'),editor:t("Editorial & publishing material", '编者与出版资料'),mixed:t("Mixed sources", '混合来源'),unknown:t("Attribution awaiting review", '来源归属待核')})[unit.authorship] || ({quotation:t("Opening quotation", '原作开场引文'),'author-inscription':t("Jung’s inscription", '荣格题记'),reflection:t("Jung’s text · reflections preserved", '荣格正文 · 保留反思')})[unit.contentType] || t("Complete original passage", '完整原段');
    renderReadingColumns();
    const aligned=Boolean(visibleComparison);
    dom['language-select'].value=language;
    const originals=unit.originalLanguage || [];dom['original-language'].hidden=!originals.length;dom['original-language'].open=false;renderParagraphs(originals,dom['original-content'],'la');
    const notice=dom['alignment-notice'];notice.replaceChildren();notice.hidden=false;
    const differences=comparisonDifferences();
    if(secondaryLanguage!=='off' && !aligned && alignmentLoadError)notice.append(node('span','',t("Pairing data is unavailable. The original text remains readable.", '对照资料暂不可用，原文仍可阅读。')),button(t("Reload pairing", '重新读取对照'),'text-button',async()=>{
      alignmentLoadError='';await loadAlignment();renderReadingColumns();updateLanguageTools();dom['notes-count'].textContent=visibleNotes().length;notice.hidden=!alignmentLoadError;if(alignmentLoadError)toast(t("Pairing data could not be verified. Showing the original text alone.", '对照资料仍未通过校验，已保留单独原文。'));
    }));
    else notice.hidden=!differences || !visibleComparison;
    if(differences)notice.append(node('span','',t(`Edition differences | ${differences}`, `版本差异｜${differences}`)));
    dom['notes-count'].textContent=visibleNotes().length;
    const order=languageOrder[language], side=visibleComparison?.[language] || [unit];
    const firstIndex=order.indexOf(side[0].id),lastIndex=order.indexOf(side.at(-1).id);
    const canPrevious=firstIndex>0,canNext=lastIndex>=0 && lastIndex<order.length-1;
    dom['previous-button'].disabled=!canPrevious;dom['next-button'].disabled=!canNext;
    dom['chapter-notes-button'].hidden=importedBook || !schema2;dom['chapter-notes-button'].textContent=t(`All chapter notes · ${(section?.noteIds?.[language] || []).length}`, `本章全部书注 · ${(section?.noteIds?.[language] || []).length}`);
    dom['scope-label'].textContent=schema2?t(`${languageLabel()} · ${sectionTitle(section)} · Passage ${Math.max(0,index)+1}/${local.length}`, `${languageLabel()} · ${sectionTitle(section)} · 章内 ${Math.max(0,index)+1}/${local.length}`):t(`Liber Primus · First ${units.length} passages`, `第一卷 · 前 ${units.length} 个阅读单元`);
    updateFavorite();updateRecordIndicator();renderIndex();updateProgress();updateLanguageTools();persist();
    document.title=t(`${sectionTitle(section) || pad(unit.order)} · ${importedBook?recordNotice(data.metadata.title):'The Red Book'} · Foliotter`, `${sectionTitle(section) || pad(unit.order)} · ${importedBook?recordNotice(data.metadata.title):'红书'} · 书獭`);dom.reader.hidden=false;
    pageReader?.setGroup({key:visibleComparison?.id || current.id,unitId:current.id,language,aligned:Boolean(visibleComparison),canPrevious,canNext});
    const saved=restore && state.positions[unit.id]?.language===language?state.positions[unit.id]:null;const target={unitId:unit.id,language,...(saved || {}),...(blockId?{blockId}:{}),...(options.offsetRatio!==undefined?{offsetRatio:options.offsetRatio}:{}),...(options.legacyScrollY!==undefined?{legacyScrollY:options.legacyScrollY}:{})};
    if(languageSession)languageSession.positions[language]={anchor:{...target,language},restore:null};
    if(!noHistory){const method=initial?'replaceState':'pushState';history[method]({anchor:target,search:{...searchSession},panel:initial?history.state?.panel:null},'',hashFor({...target,noteId}));}
    handledHash=location.hash;restoreView(target,{focus,viewport:options.viewport});if(noteId)openPanel('notes',noteId);
    loadRelated(unit.id);document.documentElement.dataset.lastNavigationMs=(performance.now()-navigationStarted).toFixed(2);return true;
  }
  function refreshPageNavigation(){
    const order=languageOrder[language],side=visibleComparison?.[language] || [current];
    const first=order.indexOf(side[0].id),last=order.indexOf(side.at(-1).id);
    const canPrevious=first>0,canNext=last>=0 && last<order.length-1;
    dom['previous-button'].disabled=!canPrevious;dom['next-button'].disabled=!canNext;
    pageReader?.setGroup({key:visibleComparison?.id || current.id,unitId:current.id,language,aligned:Boolean(visibleComparison),canPrevious,canNext});
  }
  function move(offset) {const order=languageOrder[language],side=visibleComparison?.[language] || [current],edge=offset>0?side.at(-1):side[0],next=order[order.indexOf(edge.id)+offset];if(next)showUnit(next,{language,reason:t("Read in sequence", '顺序阅读'),focus:true});}

  function shuffle(values) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i],result[j]] = [result[j],result[i]];
    }
    return result;
  }

  function nextRandomId() {
    const key=`${data.metadata?.datasetId || 'legacy-20'}:${preferredLanguage}:${randomPool.join('|')}`;
    if(state.queuePool!==key){state.queue=[];state.queuePool=key;}
    state.queue=state.queue.filter(id=>randomPool.includes(id));
    if(!state.queue.length){state.queue=shuffle(randomPool);if(state.queue.length>1 && state.queue[0]===current?.id)[state.queue[0],state.queue[1]]=[state.queue[1],state.queue[0]];}
    if(state.queue.length===1 && randomPool.length===1)toast(t("Only one passage is available in this random pool.", '当前随机范围只有1项，允许再次遇见。'));
    return state.queue.shift();
  }

  function encounter() {
    const next = nextRandomId();
    if(next)showUnit(next,{language:preferredLanguage,reason:t("Random passage", '随机遇见')});else toast(t("No eligible random passages. Choose a passage from contents.", '当前没有符合来源要求的文字随机项，可从目录阅读。'));
  }

  function updateFavorite() {
    const saved = state.favorites.includes(current.id);
    dom['favorite-button'].setAttribute('aria-pressed', String(saved));
    dom['favorite-button'].setAttribute('aria-label', saved ? t("Remove bookmark", '取消收藏本段') : t("Bookmark passage", '收藏本段'));
  }

  async function toggleFavorite() {
    if (!current) return;
    const index = state.favorites.indexOf(current.id);
    if (index >= 0) state.favorites.splice(index,1);
    else state.favorites.push(current.id);
    updateFavorite();
    updateIndex();
    const ok=await persist();
    toast(ok ? (index >= 0 ? t("Bookmark removed", '已取消收藏') : t("Passage bookmarked", '已收藏本单元')) : t("Bookmark changes are only saved in this page. Export them in Backup & restore.", '收藏修改仅在本页暂存；请打开备份与恢复导出。'));
  }

  function updateRecordIndicator() {
    dom['record-indicator'].className = state.notes[current.id]?.trim() ? 'record-dot' : '';
  }

  function panelTitle(kind){return ({notes:t("Book notes", '书中注释'),chapterNotes:t("All chapter notes", '本章全部书注'),related:t("Commentary", '相关解读'),source:t("Source editions", '版本与对应'),history:t("Reading history", '阅读足迹'),record:t("My notes", '我的记录'),contents:t("Contents", '全书目录'),search:t("Search book", '搜索书文'),records:t("Backup & restore", '备份与恢复'),'language-chapter':t("Other language in this chapter", '本章另一语言'),images:t("Images in this edition", '本版图像资源'),aids:t("Context & word notes", '前后文与词注'),dictionary:t("People, concepts & references", '人物、概念与典故')})[kind];}
  function openPanel(kind, noteId) {
    if(!current)return;
    if(importedBook && ['aids','dictionary','related','language-chapter'].includes(kind))return;
    if (!current) return;
    stopContextMotion();
    if(panel==='dictionary' && kind!=='dictionary')readingDictionary?.dismiss();
    if(kind==='language-chapter'){languageSelection={sectionId:current.sectionId,language,position:captureLanguagePosition()};}
    if(kind!=='aids' && aidSession)closePanel();
    if(kind==='aids' && !aidSession){aidSession={view:window.RedbookReader.captureViewport(),focus:window.RedbookReader.captureFocus(),release:window.RedbookReader.pausePositionWrites()};}
    if (dom['detail-panel'].hidden || !dom['detail-panel'].contains(document.activeElement)) returnFocus = document.activeElement;
    panel = kind;
    dom['panel-context'].textContent = `${languageLabel()} · ${sectionTitle(currentSection())}`;
    dom['panel-title'].textContent = panelTitle(kind);
    dom['detail-panel'].hidden = false;
    syncPanelMode();
    dom['panel-content'].scrollTop = 0;
    renderPanel();
    if (noteId) {
      const resolved=resolveNote(noteId);noteId=resolved?.id || noteId;
      if(resolved && ![...dom['panel-content'].querySelectorAll('[data-note-id]')].some(el=>el.dataset.noteId===noteId))noteGroup(t("Located edition note", '定位到的版本书注'),[resolved]);
      if(resolved){const value={...anchor(),noteId};history.replaceState({anchor:value,search:{...searchSession}},'',hashFor(value));handledHash=location.hash;}
      const target = [...dom['panel-content'].querySelectorAll('[data-note-id]')].find((item) => item.dataset.noteId === noteId);
      if (target) {
        dom['panel-content'].scrollTop = Math.max(0, target.offsetTop - dom['panel-content'].offsetTop - 16);
        target.focus({preventScroll:true});
      } else {
        dom['panel-content'].prepend(node('p','panel-intro',t("No matching note was found. The original reference is preserved.", '该标记暂未找到对应注释；保留原引用，不自动猜配。')));
        dom['panel-close'].focus({preventScroll:true});
      }
    } else dom['panel-close'].focus({preventScroll:true});
    history.replaceState({...history.state,panel:kind==='search'?'search':null,search:{...searchSession}},'',location.href);
  }

  function closePanel(restoreFocus = true) {
    if(panel==='dictionary' && restoreFocus && readingDictionary){readingDictionary.dismiss();return;}
    if(panel==='language-chapter')languageSelection=null;
    if(panel==='search'){searchSession.scroll=dom['panel-content'].scrollTop;if(restoreFocus)history.replaceState({...history.state,panel:null,search:{...searchSession}},'',location.href);}
    if (dom['detail-panel'].hidden) return;
    const aidReturn=aidSession;aidSession=null;
    dom['detail-panel'].hidden = true;
    panel = null;
    syncPanelMode();
    if(aidReturn){readingAids?.reset();aidReturn.release();if(restoreFocus){aidReturn.view?.({focus:false});aidReturn.focus?.();}return;}
    if(restoreFocus){if(returnFocus?.isConnected && returnFocus.getClientRects().length)returnFocus.focus({preventScroll:true});else ($('navigation-toggle') || dom['chapter-zh']).focus({preventScroll:true});}
  }

  function syncPanelMode() {
    const modal = Boolean(panel && mobilePanelMedia.matches);
    for (const element of panelBackground) element.inert = modal;
    if (modal) {
      dom['detail-panel'].setAttribute('role','dialog');
      dom['detail-panel'].setAttribute('aria-modal','true');
      if (!dom['detail-panel'].contains(document.activeElement)) dom['panel-close'].focus({preventScroll:true});
    } else {
      dom['detail-panel'].removeAttribute('role');
      dom['detail-panel'].removeAttribute('aria-modal');
    }
  }

  function keepPanelFocus(event) {
    if (event.key !== 'Tab' || !panel || !mobilePanelMedia.matches) return;
    const controls = [...dom['detail-panel'].querySelectorAll('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    const active = document.activeElement;
    if (!dom['detail-panel'].contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({preventScroll:true});
    }
  }

  function renderPanel() {
    if (!panel) return;
    dom['panel-content'].replaceChildren();
    ({notes:renderNotes,chapterNotes:renderChapterNotes,related:renderRelated,source:renderSources,history:renderHistory,record:renderRecord,contents:renderContents,search:renderSearch,records:renderRecords,'language-chapter':renderOtherLanguage,images:renderImages,aids:()=>readingAids?.show(dom['panel-content'],anchor()),dictionary:()=>readingDictionary?.show(dom['panel-content'])})[panel]();
  }

  function sourceLabel(source) {
    if (!source) return t("Source location not provided", '来源位置未提供');
    const parts = [];
    if (source.file) parts.push(source.file);
    if (source.anchor) parts.push(`#${source.anchor}`);
    if (source.locator) parts.push(source.locator);
    else if (source.paragraphIndex !== undefined) parts.push(t(`Paragraph index ${source.paragraphIndex}`, `段落索引 ${source.paragraphIndex}`));
    if (source.page) parts.push(t(`Page ${source.page}`, `页 ${source.page}`));
    return parts.join(' · ') || t("Source location not provided", '来源位置未提供');
  }

  function noteGroup(title, notes, target=dom['panel-content'], owner=current, onReturn=null, returnLabel=null) {
    if (!notes.length) return;
    const section = node('section','note-group');
    section.append(node('h3','',title));
    for (const note of notes) {
      const entry = node('section','note-item');
      entry.dataset.noteId = note.id;
      entry.tabIndex = -1;
      entry.lang = note.language === 'en' ? 'en' : 'zh-CN';
      entry.append(node('h4','',t(`${note.label || 'Note'} · ${note.language === 'en' ? 'English edition note' : 'Chinese edition note'}`, `${note.label || '注'} · ${note.language === 'en' ? '英文版本书注' : '中文版本书注'}`)));
      const paragraphs = Array.isArray(note.paragraphs) && note.paragraphs.length ? note.paragraphs : [note.text];
      if(note.paragraphSegments?.length){for(const segments of note.paragraphSegments){const p=node('p');appendSegments(p,segments,note.language,owner,Boolean(onReturn));entry.append(p);}}else for (const paragraph of paragraphs) entry.append(node('p','',typeof paragraph === 'string' ? paragraph : paragraph.text || ''));
      entry.append(node('div','source-location',sourceLabel(note.source)));
      entry.append(button(returnLabel || (onReturn?t("Back to context & word notes", '返回前后文与词注'):t("Back to passage", '回到原段')),'note-return',onReturn || (() => closePanel())));
      section.append(entry);
    }
    target.append(section);
  }

  function renderNotes() {
    dom['panel-content'].append(node('p','panel-intro',t("Original edition notes linked from the text. The editions are listed separately; matching numbers do not imply matching notes.", '以下为电子书原有书注，按正文链接关联。中英版本分别列出；编号相同不代表已证明是同一条注释。')));
    const sourceUnits=displayedUnits();
    const notes=schema2?[...new Map(sourceUnits.flatMap(unit=>(unit.noteIds || []).map(id=>resolveNote(id,unit)).filter(Boolean)).map(note=>[note.id,note])).values()]:current.notes || [];
    const chapters=schema2?[...new Map(sourceUnits.flatMap(unit=>(unit.chapterNoteIds || []).map(id=>resolveNote(id,unit)).filter(Boolean)).map(note=>[note.id,note])).values()]:current.chapterNotes || [];
    if (!notes.length && !chapters.length) {
      dom['panel-content'].append(node('p','panel-empty',t("No notes are linked to this passage.", '本单元没有关联书注。')));
      return;
    }
    noteGroup(t("This passage · Chinese edition", '本段 · 中文版本'),notes.filter((note) => note.language === 'zh'));
    noteGroup(t('This passage · English edition','本段 · 英文版本'),notes.filter((note) => note.language === 'en'));
    noteGroup(t("This passage · Other editions", '本段 · 其他版本'),notes.filter((note) => !['zh','en'].includes(note.language)));
    noteGroup(t("Chapter notes · Chinese edition", '本章注释 · 中文版本'),chapters.filter((note) => note.language === 'zh'));
    noteGroup(t('Chapter notes · English edition','本章注释 · 英文版本'),chapters.filter((note) => note.language === 'en'));
  }

  function infoRow(dl, label, value) {
    if (!value && value !== 0) return;
    dl.append(node('dt','',label),node('dd','',plain(value)));
  }

  function renderSources() {
    const section = node('section','source-list');
    if(importedBook){
      section.append(node('h3','',recordNotice(data.metadata.title) || t("Imported book", '导入的电子书')));
      const details=node('dl');
      infoRow(details,t("Author", '作者'),recordNotice(data.metadata.author) || t("Author not provided", '作者未标注'));
      infoRow(details,t("Language", '语言'),languageLabel());
      infoRow(details,t("Chapters", '章节'),sections.length);
      infoRow(details,t("Content source", '内容来源'),t("The book you imported locally", '你在本机导入的 EPUB'));
      infoRow(details,t("File identifier", '文件标识'),data.metadata.datasetId);
      section.append(details,node('p','panel-intro',t("This book is parsed and read locally. Text and images keep their original order. Book scripts, external resources and fonts are not loaded. Bookmarks, notes and positions belong to this book.", '本书在本机解析和阅读。图片与文字按原书顺序提取；脚本、外部资源和原书字体不会执行或加载。收藏、笔记与阅读位置仅属于这一本书。')));
      if(data.metadata.limitations?.length){const list=node('ul');for(const item of data.metadata.limitations)list.append(node('li','',recordNotice(item)));section.append(node('h3','',t("Import details", '导入说明')),list);}
      dom['panel-title'].textContent=t("Book information", '电子书信息');dom['panel-content'].append(section);return;
    }
    section.append(node('h3','',t("Language pairing", '双语对应')));
    const comparison=comparisonFor();
    section.append(node('p','',comparison?comparison.legacy?t("This passage uses the existing source review. It does not imply expert review of the translation.", '本单元沿用原有来源复核；复核范围不等于人工专家译文校勘。'):t("Passage boundaries were checked against both editions. Multiple passages remain grouped; sentence matches are not inferred.", '本组已对照两种底本核对段落边界及内容。多段对应保留整组，不拆句猜配。'):t("Read this passage independently in its source edition. No verified cross-language counterpart is available.", '本单元按底本独立阅读，尚无已确认的跨语言段落对应。')));
    const alignment = node('dl');
    infoRow(alignment,t("Review status", '校对状态'),comparison?(comparison.legacy?t("Existing source review", '沿用首批来源复核'):t("Passages checked", '段落已核对')):alignmentLoadError?t("Pairing data unavailable", '对照资料暂不可用'):t("No verified counterpart", '尚无已确认对应'));
    if(comparison&&!comparison.legacy){
      infoRow(alignment,t("Pairing group", '对照分组'),comparison.id);
      infoRow(alignment,t("Review method", '核对方式'),t("Agent review of source editions; not human expert approval", '代理对照底本阅读；不代表人工专家审定'));
      infoRow(alignment,t("Review record", '核对记录'),comparison.review?.evidence);
    }
    infoRow(alignment,t("Stable identifier", '稳定标识'),current.id);
    infoRow(alignment,t("Original passage count", '原段数量'),t(`Chinese ${(comparison?.zh || [current]).reduce((count,unit)=>count+(unit.zh || []).length,0)} passages / English ${(comparison?.en || [current]).reduce((count,unit)=>count+(unit.en || []).length,0)} passages`, `中文 ${(comparison?.zh || [current]).reduce((count,unit)=>count+(unit.zh || []).length,0)} 段 / 英文 ${(comparison?.en || [current]).reduce((count,unit)=>count+(unit.en || []).length,0)} 段`));
    section.append(alignment);
    const differences = comparisonDifferences();
    if (plain(differences)) section.append(node('h3','',t("Preserved edition differences", '保留的版本差异')),node('p','',plain(differences)));
    for (const [key,title] of [['zh',t("Original Chinese passage", '中文原段')],['en','English source paragraphs'],['originalLanguage',t("Additional source text", '原作附载文本')]]) {
      const sourceUnits=comparison&&['zh','en'].includes(key)?comparison[key]:[current];
      if (!sourceUnits.some(unit=>unit[key]?.length)) continue;
      section.append(node('h3','',title));
      for (const unit of sourceUnits) for (const paragraph of unit[key] || []) {
        const dl = node('dl');
        infoRow(dl,t("Reading unit", '阅读单元'),unit.id);
        infoRow(dl,t("Paragraph identifier", '段落标识'),paragraph.id);
        infoRow(dl,t("Location inside book", '电子书内部位置'),sourceLabel(paragraph.source));
        if (paragraph.source?.epub) infoRow(dl,t("Source book", '来源电子书'),paragraph.source.epub);
        infoRow(dl,t("Note references", '书注引用'),(paragraph.noteIds || []).join('、') || t("None", '无'));
        section.append(dl);
      }
    }
    section.append(node('h3','',t("Local source files", '本地源文件')));
    for (const source of data.metadata?.sourceFiles || []) {
      const dl = node('dl');
      infoRow(dl,t("Edition", '版本'),source.language === 'zh' ? '中文' : source.language === 'en' ? t("English", '英文') : source.language);
      infoRow(dl,t("File", '文件'),source.path || source.filename);
      infoRow(dl,'SHA-256',source.sha256);
      section.append(dl);
    }
    section.append(node('p','panel-intro',t("Full book text is processed locally. Online search uses topics and short keywords, not the full text of this page.", '完整书文仅用于本机正文提取。网络检索使用主题与短关键词，不发送这一页的全文。')));
    dom['panel-content'].append(section);
  }

  function historyList(entries, emptyText) {
    if (!entries.length) { dom['panel-content'].append(node('p','panel-intro',emptyText)); return; }
    const list = node('ul','history-list');
    for (const entry of entries) {
      const unit = unitById(entry.id);
      if (!unit) continue;
      const li = node('li');
      const control = button('', '', () => showUnit(unit.id, {reason:t("Revisit", '回看'),restore:true}));
      control.append(node('span','history-number',pad(unit.order)));
      const content = node('span');
      content.append(node('span','history-preview',preview(unit)));
      content.append(node('span','history-date',entry.at ? t(`${formattedDate(entry.at)} · ${entry.reason || 'Reading'}`, `${formattedDate(entry.at)} · ${entry.reason || '阅读'}`) : t("Bookmarked", '已收藏')));
      control.append(content);
      li.append(control);
      list.append(li);
    }
    dom['panel-content'].append(list);
  }

  function renderHistory() {
    dom['panel-content'].append(node('p','panel-intro',t("Open a passage at its last reading position. Records stay in this browser.", '点击回到原单元及上次阅读位置。记录只保存在这个浏览器中。')));
    dom['panel-content'].append(node('h3','',t(`Bookmarks · ${state.favorites.length}`, `收藏 · ${state.favorites.length}`)));
    historyList(state.favorites.filter(id=>unitById(id)).map((id) => ({id})), t("No bookmarks yet. Use the bookmark button above the text to save a passage.", '还没有收藏。正文上方的书签按钮可保存喜欢的单元。'));
    dom['panel-content'].append(node('h3','',t("Recent reading", '最近阅读')));
    historyList(state.history, t("Passages you read appear here.", '读过的单元会出现在这里。'));
  }

  function renderRecord() {
    const section = node('section','personal-record');
    section.append(node('p','panel-intro',t("Write your own thoughts. Notes stay in this browser and are not sent to search services.", '先记下你自己的想法。内容只保存在此浏览器，不发送到检索服务。')));
    const label = node('label','',t("This passage makes me think of…", '这一段让我想到…'));
    label.htmlFor = 'personal-note';
    const textarea = node('textarea');
    textarea.id = 'personal-note';
    textarea.placeholder = t("Write your thoughts, questions or associations.", '写下此刻的理解、问题或联想。');
    textarea.value = state.notes[current.id] || '';
    const saved = node('div','save-state', storageAvailable ? t("Automatically saved locally as you type", '输入后自动保存在本机') : t("Browser storage unavailable; saved for this session only", '浏览器存储不可用；本次仅暂存'));
    const unitId = current.id;
    textarea.addEventListener('input', async () => {
      if(pausedPosition)return;
      state.notes[unitId] = textarea.value;
      const serial=++recordSaveSerial; saved.textContent=t("Saving…", '正在保存…');
      const ok=await persist();
      updateRecordIndicator();
      if(serial===recordSaveSerial)saved.textContent=ok ? t("Saved locally", '已保存在本机') : t("Not saved yet. Your text remains in this page. Export a backup in Backup & restore.", '尚未保存；输入保留在本页，请打开“备份与恢复”导出备份。');
    });
    section.append(label,textarea,saved);
    dom['panel-content'].append(section);
  }

  function verifiedResults(item) {
    return (item?.results || []).filter((result) =>
      result && typeof result.author === 'object' && result.author?.name && result.author.identity &&
      safeURL(result.author.identityUrl) && safeURL(result.url) && result.verifiedAt && result.sourceHash &&
      result.interpretation?.zh && result.interpretation?.en && ['direct','chapter','theme'].includes(result.relation)
    );
  }

  function authorCount(item) {
    return new Set(verifiedResults(item).map((result) => result.author.id || result.author.name)).size;
  }

  function researchPhase(item) {
    return ({queued:t("Preparing search", '准备检索'),searching:t("Finding sources", '查找来源'),reading:t("Reading sources", '读取来源正文'),matching:t("Checking passage relevance", '核对段落关联'),translating:t("Preparing bilingual summaries", '整理双语转述'),checking:t("Verifying authors and sources", '核验作者与出处'),complete:t("Verification complete", '核验完成'),failed:t("Update incomplete", '本次更新未完成')})[item?.research?.phase] || t("Find commentary", '查找解读');
  }

  function relatedStatus(item) {
    if (!item) return t("Not searched yet", '尚未查找');
    if(item.reason==='target_missing')return t("No reviewed commentary target for this passage", '本单元尚无审核后的解读目标');
    if(item.reason==='fingerprint_mismatch')return t("The source fingerprint changed; review is required", '原文指纹变化，需要重新核对');
    if(item.reason==='source_missing')return t("Commentary sources unavailable", '解读来源暂不可用');
    const count = authorCount(item);
    if (item.stopped) return count ? t(`${count} authors · Stopped waiting for update`, `${count} 位作者观点 · 已停止等待更新`) : t("Stopped waiting; you can search again", '已停止等待，可重新查找');
    if (item.research?.running) return count ? t(`${count} authors · Background: ${researchPhase(item)}`, `${count} 位作者观点 · 后台${researchPhase(item)}`) : t(`Background: ${researchPhase(item)}`, `后台${researchPhase(item)}`);
    if (item.requestPending || item.status === 'loading') return count ? t(`${count} authors · Updating`, `${count} 位作者观点 · 正在更新`) : t("Loading commentary status", '正在读取解读状态');
    if (count) return t(`${count} authors${item.cached ? ' · Cached' : ''}`, `${count} 位作者观点${item.cached ? ' · 已缓存' : ''}`);
    if (item.status === 'empty' || item.status === 'ready') return t("No verified commentary yet", '暂无已核实解读');
    if (item.status === 'unavailable') return t("Commentary search unavailable", '解读查找暂不可用');
    if (item.status === 'error') return t("Search failed; you can retry", '本次查找失败，可重试');
    return t("Not searched yet", '尚未查找');
  }

  function relatedKey(id){return `${dataset}:${data.metadata?.datasetId || 'legacy'}:${id}`;}
  function relatedSignature(item) {
    return JSON.stringify({unit:current.id,item});
  }

  function updateRelatedUI() {
    const item = relatedByUnit.get(relatedKey(current.id));
    dom['related-status'].textContent = relatedStatus(item);
    const waiting = !item?.stopped && (item?.requestPending || item?.research?.running || item?.status === 'loading');
    dom['search-indicator'].className = `status-dot ${waiting ? 'loading' : verifiedResults(item).length ? 'ready' : ''}`;
    if (panel === 'related' && relatedRenderSignature !== relatedSignature(item)) {
      const content = dom['panel-content'];
      const scroll = content.scrollTop;
      const active = document.activeElement;
      const hadFocus = content.contains(active);
      const focusKey = active?.dataset?.focusKey;
      const expanded = [...content.querySelectorAll('details[open][data-evidence-id]')].map((details) => details.dataset.evidenceId);
      renderPanel();
      content.querySelectorAll('details[data-evidence-id]').forEach((details) => { details.open = expanded.includes(details.dataset.evidenceId); });
      if (hadFocus) {
        const target = focusKey && [...content.querySelectorAll('[data-focus-key]')].find((element) => element.dataset.focusKey === focusKey);
        (target || dom['panel-close']).focus({preventScroll:true});
      }
      content.scrollTop = scroll;
    }
  }

  function abortActive() {
    clearTimeout(relatedPollTimer);
    relatedPollTimer = null;
    if (controller) controller.abort();
    controller = null;
    requestSerial += 1;
    for (const [id,item] of relatedByUnit) {
      if (item.requestPending || item.status === 'loading' || item.research?.running) {
        relatedByUnit.set(id,{...item,requestPending:false,stopped:true});
      }
    }
  }

  async function loadRelated(unitId, refresh = false) {
    if(importedBook)return;
    abortActive();
    const serial = requestSerial;
    const previous = relatedByUnit.get(relatedKey(unitId));
    relatedByUnit.set(relatedKey(unitId),{
      ...previous,
      status:previous?.status || 'loading',
      results:previous?.results || [],
      requestPending:true,
      stopped:false,
      refreshFailed:false,
      notice:refresh ? t("Updating commentary. Previously verified views remain available.", '正在更新解读；已核实的观点继续保留。') : previous?.notice || t("The text is ready. Sources are searched in the background and will not open automatically.", '正文已就绪。资料在后台查找，完成后不会自动展开。')
    });
    updateRelatedUI();
    await fetchRelatedSnapshot(unitId,serial,{refresh});
  }

  async function fetchRelatedSnapshot(unitId,serial,{refresh = false,poll = false} = {}) {
    if (importedBook || serial !== requestSerial || current.id !== unitId) return;
    controller = new AbortController();
    try {
      const suffix = refresh ? '&refresh=1' : poll ? '&poll=1' : '';
      const response = await fetch(`/api/related?dataset=${dataset}&unit=${encodeURIComponent(unitId)}${suffix}`, {signal:controller.signal,cache:'no-store'});
      const result=await response.json();
      if(!response.ok){const error=new Error(result.notice || t(`Service returned ${response.status}`, `服务返回 ${response.status}`));error.reason=result.reason;throw error;}
      if (serial !== requestSerial || current.id !== unitId) return;
      if(result.dataset!==dataset || result.datasetId!==(data.metadata?.datasetId || null))throw new Error(t("Commentary data version mismatch. Reload and retry.", '解读数据版本不一致，请刷新后重试'));
      if (result.unitId !== unitId) throw new Error(t("Commentary passage identifier mismatch", '解读结果的单元标识不一致'));
      if (!['ready','empty','unavailable','error'].includes(result.status)) throw new Error(t("Commentary service returned an unknown status", '解读服务返回了未知状态'));
      const previous = relatedByUnit.get(relatedKey(unitId));
      const supplied = Array.isArray(result.results) ? result.results : [];
      const keepPrevious = supplied.length === 0 && (result.research?.running || result.research?.phase === 'failed');
      relatedByUnit.set(relatedKey(unitId),{
        ...result,
        results:keepPrevious ? previous?.results || [] : supplied,
        requestPending:false,
        stopped:false,
        refreshFailed:Boolean(result.refreshFailed || result.research?.phase === 'failed')
      });
      if (result.research?.running && !['target_missing','source_missing'].includes(result.reason)) {
        const delay = Math.min(10000,Math.max(500,Number(result.nextPollMs) || 1500));
        relatedPollTimer = setTimeout(() => {
          relatedPollTimer = null;
          fetchRelatedSnapshot(unitId,serial,{poll:true});
        },delay);
      }
    } catch (error) {
      if (serial !== requestSerial || current.id !== unitId) return;
      const previous = relatedByUnit.get(relatedKey(unitId));
      relatedByUnit.set(relatedKey(unitId),{
        ...previous,
        reason:error.reason,
        status:verifiedResults(previous).length ? 'ready' : 'error',
        results:previous?.results || [],
        requestPending:false,
        stopped:error.name === 'AbortError',
        refreshFailed:verifiedResults(previous).length > 0,
        research:{...previous?.research,running:false,phase:'failed'},
        notice:error.name === 'AbortError' ? t("Stopped waiting on this page. The background task may still finish.", '已停止在此页面等待；后台任务可能继续完成。') : t(`Unable to load commentary update: ${error.message}. Existing views and text remain readable.`, `未能读取解读更新：${error.message}。已有观点和正文仍可阅读。`)
      });
    } finally {
      if (serial === requestSerial && current.id === unitId) {
        controller = null;
        updateRelatedUI();
      }
    }
  }

  function stopRelated() {
    abortActive();
    const item = relatedByUnit.get(relatedKey(current.id));
    if (item) item.notice = t("Stopped waiting. The background task may still finish and cache its results. Text, existing commentary and reading position remain available.", '已停止在此页面等待。后台任务可能继续完成并写入缓存；正文、已有观点和阅读位置保持不变。');
    updateRelatedUI();
  }

  function relatedControl(text,action,key) {
    const control = button(text,'small-button',action);
    control.dataset.focusKey = `related-${key}`;
    return control;
  }

  function verifiedDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || t("Not provided", '未提供'));
    return new Intl.DateTimeFormat(uiLocale()==='zh'?'zh-CN':'en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
  }

  function sourceLink(text,url,key) {
    const link = node('a','',text);
    link.href = safeURL(url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (key) link.dataset.focusKey = key;
    return link;
  }

  function bilingualStatement(parent,title,zh,en,className = '') {
    const section = node('div',className);
    if (title) section.append(node('h4','',title));
    if (zh) { const p = node('p','statement-zh',plain(zh)); p.lang = 'zh-CN'; section.append(p); }
    if (en) { const p = node('p','statement-en',plain(en)); p.lang = 'en'; section.append(p); }
    parent.append(section);
  }

  function renderInterpretation(result) {
    const section = node('article','interpretation-card');
    section.dataset.interpretationId = result.id;
    const heading = node('div','interpretation-heading');
    const author = node('h3','',result.author.name);
    const relation = node('span','interpretation-relation',({direct:t("Directly discusses this passage", '直接解释本段'),chapter:t("Related to this chapter", '同章相关'),theme:t("Related to this topic", '主题相关')})[result.relation]);
    heading.append(author,relation);
    section.append(heading);
    const identity = node('p','author-identity',result.author.identity);
    identity.append(document.createTextNode(' · '),sourceLink(t("Author credentials", '身份出处'),result.author.identityUrl,`${result.id}-identity`));
    section.append(identity);
    const origin = node('div','interpretation-origin');
    origin.append(sourceLink(result.title || t("Read original source", '阅读原始来源'),result.url,`${result.id}-source`));
    origin.append(node('p','',t(`${result.publishedAt || 'Publication date not provided'} · Original: ${({en:'English',zh:'Chinese',bilingual:'Bilingual'})[result.originalLanguage] || 'Language not specified'}`, `${result.publishedAt || '发布日期未提供'} · 原文${({en:'英文',zh:'中文',bilingual:'双语'})[result.originalLanguage] || '语言未标注'}`)));
    if (result.dateNote) origin.append(node('p','',result.dateNote));
    section.append(origin);
    const thoughts = node('div','interpretation-body');
    const zhLabel = node('div','interpretation-label',result.interpretation.labelZh || t("Source-based summary · not the author’s words", '资料辅助转述 · 非作者原话'));
    thoughts.append(zhLabel);
    bilingualStatement(thoughts,null,result.interpretation.zh,null,'interpretation-language');
    const enLabel = node('div','interpretation-label',result.interpretation.labelEn || 'Source-based paraphrase · not a quotation');
    enLabel.lang = 'en';
    thoughts.append(enLabel);
    bilingualStatement(thoughts,null,null,result.interpretation.en,'interpretation-language');
    section.append(thoughts);
    bilingualStatement(section,t("Relation to this passage", '与本段的关系'),result.match?.zh,result.match?.en,'interpretation-match');
    const details = node('details','interpretation-evidence');
    details.dataset.evidenceId = result.id;
    const summary = node('summary','',t("Sources & verification", '来源与核验'));
    summary.dataset.focusKey = `${result.id}-evidence`;
    details.append(summary);
    if (result.match?.locator) details.append(node('p','result-meta',t(`Matched location: ${plain(result.match.locator)}`, `匹配位置：${plain(result.match.locator)}`)));
    if (result.evidence?.excerpt) {
      details.append(node('h4','',t("Short source quotation", '来源原文短引')));
      const excerpt = node('blockquote','',plain(result.evidence.excerpt));
      excerpt.lang = result.originalLanguage === 'zh' ? 'zh-CN' : 'en';
      details.append(excerpt);
    }
    if (result.evidence?.locator) details.append(node('p','result-meta',t(`Evidence location: ${plain(result.evidence.locator)}`, `证据位置：${plain(result.evidence.locator)}`)));
    if (result.publicationTitle) details.append(node('p','result-meta',t(`Publication: ${result.publicationTitle}. Different authors in one book count as one publication.`, `所据出版物：${result.publicationTitle}。同一书中的不同作者不计作不同出版物。`)));
    if (result.verification?.method) details.append(node('p','result-meta',t(`Verification method: ${plain(result.verification.method)}`, `核验方法：${plain(result.verification.method)}`)));
    if (result.verification?.review) details.append(node('p','result-meta',t(`Verification record: ${plain(result.verification.review)}`, `核验记录：${plain(result.verification.review)}`)));
    details.append(node('p','result-meta',t(`Verified: ${verifiedDate(result.verifiedAt)}`, `核验时间：${verifiedDate(result.verifiedAt)}`)));
    section.append(details);
    return section;
  }

  function renderRelated() {
    const item = relatedByUnit.get(relatedKey(current.id));
    const results = verifiedResults(item);
    relatedRenderSignature = relatedSignature(item);
    dom['panel-content'].append(node('p','search-status',relatedStatus(item)));
    dom['panel-content'].append(node('p','panel-intro',t("Each view keeps its author and source. Summaries, quotations and passage relevance are labeled separately. Original book notes remain in Book notes.", '每条观点保留真实作者与来源。双语转述、原话短引和本段关联分别标明；书中原有注释仍在“书中注释”中。')));
    if (item?.notice) dom['panel-content'].append(node('p','panel-intro',item.notice));
    const actions = node('div','search-actions');
    const waiting = !item?.stopped && (item?.requestPending || item?.research?.running || item?.status === 'loading');
    if (waiting) actions.append(relatedControl(t("Stop waiting", '停止等待'),stopRelated,'stop'));
    else if(!['target_missing','source_missing','fingerprint_mismatch'].includes(item?.reason))actions.append(relatedControl(t("Refresh commentary", '更新解读'),() => loadRelated(current.id,true),'refresh'));
    else {const disabled=relatedControl(t("Update unavailable", '更新暂不可用'),null,'refresh-disabled');disabled.disabled=true;actions.append(disabled);}
    actions.append(relatedControl(t("Back to passage", '回到原段'),() => closePanel(),'return'));
    dom['panel-content'].append(actions);
    if (item?.research?.message && !item.stopped) dom['panel-content'].append(node('p','research-progress',item.research.message));
    const research = item?.research;
    const errors = Array.isArray(research?.errors) ? research.errors.filter((error) => typeof error === 'string') : [];
    if (errors.length || typeof research?.searchCompleted === 'boolean' || Number.isFinite(research?.onlineSourceCount) || Number.isFinite(research?.elapsedSeconds)) {
      const details = node('details','interpretation-evidence research-details');
      details.dataset.evidenceId = 'research-update';
      const summary = node('summary','',t("Update details", '本次更新详情'));
      summary.dataset.focusKey = 'related-update-details';
      details.append(summary);
      if (typeof research.searchCompleted === 'boolean') details.append(node('p','result-meta',t(`Source search: ${research.searchCompleted ? 'Complete' : 'Incomplete'}`, `来源检索：${research.searchCompleted ? '已完成' : '尚未完成'}`)));
      if (Number.isFinite(research.onlineSourceCount)) details.append(node('p','result-meta',t(`Online sources this update: ${research.onlineSourceCount}`, `本次在线来源：${research.onlineSourceCount} 项`)));
      if (Number.isFinite(research.elapsedSeconds)) details.append(node('p','result-meta',t(`Elapsed: ${research.elapsedSeconds.toFixed(1)} seconds`, `本次用时：${research.elapsedSeconds.toFixed(1)} 秒`)));
      if (errors.length) {
        details.append(node('p','result-meta',t("Source errors are listed individually. One failed source does not invalidate verified results.", '来源错误逐项记录；某一来源失败不代表整次更新全部失败，已核实的观点仍然保留。')));
        const list = node('ul','research-errors');
        for (const error of errors) list.append(node('li','',error));
        details.append(list);
      }
      dom['panel-content'].append(details);
    }
    const candidateCount = Number(item?.research?.unverifiedCandidateCount) || 0;
    if (candidateCount) dom['panel-content'].append(node('p','result-meta',t(`${candidateCount} additional leads await verification and are not shown as author views.`, `另有 ${candidateCount} 条检索线索待核实，暂不作为作者观点展示。`)));
    if (item?.refreshFailed) dom['panel-content'].append(node('p','panel-intro',t("This update is incomplete. Previously verified views remain readable.", '本次更新未完成，仍可阅读之前核实的观点。')));
    if (item?.lastVerifiedAt) dom['panel-content'].append(node('p','result-meta',t(`Last verified: ${verifiedDate(item.lastVerifiedAt)}${item.cached ? ' · From local cache' : ''}`, `最近核验：${verifiedDate(item.lastVerifiedAt)}${item.cached ? ' · 从本地缓存读取' : ''}`)));
    if (results.length) {
      const count = (relation) => results.filter((result) => result.relation === relation).length;
      dom['panel-content'].append(node('p','interpretation-coverage-count',t(`Direct ${count('direct')} · Same chapter ${count('chapter')} · Same topic ${count('theme')}`, `直接解释本段 ${count('direct')} 条 · 同章相关 ${count('chapter')} 条 · 主题相关 ${count('theme')} 条`)));
    }
    if (item?.coverage?.gapZh || item?.coverage?.gapEn) bilingualStatement(dom['panel-content'],t("Source coverage", '资料覆盖'),item.coverage.gapZh,item.coverage.gapEn,'interpretation-coverage');
    for (const result of results) dom['panel-content'].append(renderInterpretation(result));
    if (!results.length && !waiting) dom['panel-content'].append(node('p','panel-empty',item?.reason==='target_missing'?t("No reviewed search target for this passage. The original text remains readable.", '本单元尚无审核后的检索目标，原文可继续阅读。'):t("No verified bilingual commentary for this passage yet. Read the original text and check again later.", '这段暂时没有核实完成的双语作者解读。你可以先读原文，稍后再查。')));
  }

  function renderChapterNotes() {
    const ids=currentSection()?.noteIds?.[language] || [];
    dom['panel-content'].append(node('p','panel-intro',t(`${language==='zh'?'Chinese':'English'} edition notes for this chapter, including notes not linked inline. Numbers are specific to this edition.`, `本章${language==='zh'?'中文':'英文'}版本书注，含没有段内引用的注释。编号仅用于本版显示。`)));
    let shown=0;const more=()=>{noteGroup(t("Edition notes", '版本书注'),ids.slice(shown,shown+40).map(id=>data.notesById[id]).filter(Boolean));shown+=40;control.hidden=shown>=ids.length;};
    const control=button(t("Show more notes", '继续显示书注'),'small-button',()=>{control.remove();more();dom['panel-content'].append(control);});
    if(!ids.length)dom['panel-content'].append(node('p','panel-empty',t("No edition notes in this language for this chapter.", '本章此语言没有版本书注。')));else{more();dom['panel-content'].append(control);}
  }
  function sectionEntry(section,lang) {
    if(!section)return null;
    return section?.readingOrder?.[lang]?.[0] || childrenOf(section?.id).map(s=>sectionEntry(s,lang)).find(Boolean);
  }
  function childrenOf(parent=null) {return sections.filter(s=>(s.parentId || null)===parent).sort((a,b)=>a.order-b.order);}
  function renderContents() {
    const root=dom['panel-content'];root.append(node('p','panel-intro',importedBook?t("Read chapters in the imported book’s original order.", '按导入电子书的章节与内容顺序阅读。'):t("Browse volumes, chapters and sections. Each language follows its source order; chapter matches do not imply passage matches.", '按卷、章和子节打开。中文与英文各自按底本顺序阅读；同章入口不表示逐段对齐。')));
    const filters=node('div','directory-filters');
    const lang=node('select');lang.setAttribute('aria-label',t("Contents language", '目录语言'));for(const [id,label] of languageOptions()){const o=node('option','',label);o.value=id;lang.append(o);}lang.value=directoryLanguage || language;lang.hidden=importedBook;
    const type=node('select');type.setAttribute('aria-label',t("Contents scope", '目录范围'));for(const [id,label] of [['all',t("All contents", '全部目录')],['main',t("Main text", '正文')],['extra',t("Additions & appendices", '原作补充与附录')],['support',t("Supporting material", '资料')]]){const o=node('option','',label);o.value=id;type.append(o);}
    filters.append(lang,type);root.append(filters);const tree=node('nav','contents-tree');tree.setAttribute('aria-label',t("Volumes, chapters & sections", '卷章子节目录'));root.append(tree);
    const build=()=>{
      tree.replaceChildren();
      const visible=section=>type.value==='all' || scopeKind(section)===type.value || childrenOf(section.id).some(visible);
      const branch=section=>{
        const details=node('details','toc-section'),summary=node('summary','',sectionTitle(section,lang.value));
        summary.append(node('span','toc-count',t(`${(section.readingOrder?.[lang.value] || []).length} passages`, `${(section.readingOrder?.[lang.value] || []).length}项`)));details.append(summary);
        const body=node('div','toc-body');details.append(body);let populated=false;
        const populate=()=>{
          if(populated || !details.open)return;populated=true;
          const ids=section.readingOrder?.[lang.value] || [];
          if(!importedBook)body.append(button(t("People, concepts & references in this chapter", '本章人物、概念与典故'),'dict-action',()=>readingDictionary?.openChapter(section.id,lang.value)));
          if(ids.length){body.append(button(t(`Start this section · ${languageLabel(lang.value)}`, `从本节开始 · ${languageLabel(lang.value)}`),'small-button',()=>showUnit(ids[0],{language:lang.value,reason:t("Chapter contents", '章节目录'),focus:true})));let count=0;const list=node('div','toc-units');body.append(list);
            const more=button(t("Show more passages", '显示更多单元'),'text-button',()=>{more.remove();add();list.append(more);});
            const add=()=>{for(const id of ids.slice(count,count+50)){const u=unitById(id),b=button(t(`${ids.indexOf(id)+1}  ${preview(u) || (u.kind==='image'?'Book image':'Heading or structural block')}`, `${ids.indexOf(id)+1}  ${preview(u) || (u.kind==='image'?'书内图页':'标题或结构块')}`),'toc-unit',()=>showUnit(id,{language:lang.value,reason:t("Chapter contents", '章节目录'),focus:true}));b.setAttribute('aria-current',String(current?.id===id));list.append(b);}count+=50;more.hidden=count>=ids.length;};add();list.append(more);
          }
          const noteCount=section.noteIds?.[lang.value]?.length || 0;
          if(noteCount){body.append(button(t(`All section notes · ${noteCount}`, `本节全部书注 · ${noteCount}`),'text-button',()=>{const id=sectionEntry(section,lang.value);if(id){showUnit(id,{language:lang.value,reason:t("Chapter notes", '章节书注')});openPanel('chapterNotes');}}));}
          for(const child of childrenOf(section.id).filter(visible))body.append(branch(child));
          if(!ids.length && !childrenOf(section.id).length)body.append(node('p','panel-intro',t("This section is absent from this edition. Switch the contents language.", '此版本没有本节内容，可切换目录语言。')));
        };
        details.addEventListener('toggle',()=>{if(details.open){for(const sibling of details.parentElement?.children || [])if(sibling!==details && sibling.tagName==='DETAILS')sibling.open=false;populate();}else{body.replaceChildren();populated=false;}});
        let active=currentSection();while(active){if(active.id===section.id){details.open=true;break;}active=sectionMap.get(active.parentId);}populate();return details;
      };
      for(const section of childrenOf().filter(visible))tree.append(branch(section));
    };
    lang.addEventListener('change',()=>{directoryLanguage=lang.value;build();});type.addEventListener('change',build);build();
    if(schema2)root.append(button(t("View all images in this edition", '查看本版全部图像资源'),'small-button',()=>{imageLanguage=lang.value;openPanel('images');}));
  }
  function renderOtherLanguage() {
    const section=currentSection(),other=language==='zh'?'en':'zh',ids=section?.readingOrder?.[other] || [],label=other==='en'?'English':'中文',root=dom['panel-content'];
    dom['panel-title'].textContent=t(`This chapter · ${label}`, `本章 ${label}`);
    root.append(node('p','panel-intro',t(`Complete ${other==='en'?'English':'Chinese'} source: ${ids.length} passages. Choose a location; you can return to your previous ${language==='zh'?'Chinese':'English'} position. Languages follow their own order without inferred pairings.`, `完整${other==='en'?'英文':'中文'}底本，共 ${ids.length} 项。选择要读的位置，稍后可返回刚才的${language==='zh'?'中文':'英文'}。两语按各自原序阅读，尚未逐段配对。`)));
    if(!canReadBoth()){root.append(button(t(`Open ${label} contents`, `打开 ${label} 目录`),'small-button',()=>{directoryLanguage=other;openPanel('contents');}));return;}
    const saved=languageSession?.positions[other];
    if(validLanguagePosition(saved,other))root.append(button(t(`Resume ${other==='en'?'English':'Chinese'}`, `继续刚才的${other==='en'?'英文':'中文'}`),'primary-button',()=>readLanguage(other)));
    root.append(button(t(`Start this chapter in ${other==='en'?'English':'Chinese'}`, `从${other==='en'?'英文':'中文'}章首开始`),'small-button language-start',()=>chooseLanguageUnit(ids[0],other)));
    const progress=node('p','search-summary');root.append(progress);
    let shown=0;const more=button(t("Show more", '继续显示'),'small-button',()=>{more.remove();add();root.append(more);});
    const add=()=>{for(const id of ids.slice(shown,shown+50)){const u=unitById(id),item=button(t(`${ids.indexOf(id)+1}  ${(u[other]||[]).map(p=>p.text).join(' ').slice(0,100) || 'Book image'}`, `${ids.indexOf(id)+1}  ${(u[other]||[]).map(p=>p.text).join(' ').slice(0,100) || '书内图页'}`),'toc-unit',()=>chooseLanguageUnit(id,other));item.dataset.languageUnit=id;root.append(item);}shown=Math.min(ids.length,shown+50);more.hidden=shown>=ids.length;progress.textContent=t(`Showing ${shown} of ${ids.length}`, `已显示 ${shown} / ${ids.length} 项`);};add();root.append(more);
  }
  function renderImages() {
    dom['panel-content'].append(node('p','panel-intro',t("Images from the supplied book, including publishing details, symbols and plates. Some are outside the artwork pool.", '保留所提供电子书的图像；部分为出版信息、符号或图版，并非全部属于原画随机池。')));
    const items=Object.values(data.imagesById || {}).filter(i=>i.bookId.startsWith((imageLanguage || language)+'-'));let shown=0;
    const more=button(t("Show more images", '继续显示图像'),'small-button',()=>{more.remove();add();dom['panel-content'].append(more);});
    const add=()=>{for(const image of items.slice(shown,shown+20)){
      const figure=imageNode(image.id);dom['panel-content'].append(figure);
      const occurrence=image.occurrences?.find(o=>blockOwners.has(o.blockId));
      if(occurrence){const owner=blockOwners.get(occurrence.blockId);dom['panel-content'].append(button(t("Open location in book", '打开书内位置'),'text-button',()=>showUnit(owner.unitId,{language:owner.language,blockId:occurrence.blockId,reason:t("Image location", '图像资源位置'),focus:true})));}
    }shown+=20;more.hidden=shown>=items.length;};add();dom['panel-content'].append(more);
  }
  function buildSearchIndex() {
    const started=performance.now();searchIndex=[];
    for(const unit of units)for(const lang of ['zh','en'])for(const paragraph of unit[lang] || [])searchIndex.push({entityType:'unit',entityId:unit.id,unitId:unit.id,sectionId:unit.sectionId,blockId:paragraph.id,language:lang,text:paragraph.text || '',sourceOrder:searchIndex.length});
    if(schema2)for(const note of Object.values(data.notesById))searchIndex.push({entityType:'note',entityId:note.id,unitId:noteOwners.get(note.id) || sectionEntry(sectionMap.get(note.sectionId),note.language),sectionId:note.sectionId,language:note.language,text:note.paragraphs.join('\n'),sourceOrder:searchIndex.length});
    else for(const unit of units)for(const note of allNotes(unit))searchIndex.push({entityType:'note',entityId:note.id,unitId:unit.id,sectionId:unit.sectionId,language:note.language,text:(note.paragraphs || [note.text]).join('\n'),sourceOrder:searchIndex.length});
    indexReady=true;document.documentElement.dataset.searchIndexMs=(performance.now()-started).toFixed(2);
  }
  function literalExcerpt(row,query) {
    const text=row.text,at=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()),start=Math.max(0,at-35),end=Math.min(text.length,at+query.length+90),span=node('span','search-excerpt');
    if(start)span.append(document.createTextNode('…'));
    span.append(document.createTextNode(text.slice(start,at)));span.append(node('mark','',text.slice(at,at+query.length)));span.append(document.createTextNode(text.slice(at+query.length,end)));if(end<text.length)span.append(document.createTextNode('…'));return span;
  }
  function renderSearch() {
    const root=dom['panel-content'];root.append(node('p','panel-intro',t("Search this book locally, ignoring letter case. Text and notes are not uploaded.", '只搜索当前电子书中的文字，忽略字母大小写；不会上传正文或笔记。')));
    const form=node('form','book-search'),label=node('label','',t("Find words or phrases", '查找词句'));label.htmlFor='book-query';const input=node('input');input.id='book-query';input.type='search';input.value=searchSession.query;input.placeholder=t("Enter words from the original text", '输入原文中的词句');
    const scope=node('select');scope.setAttribute('aria-label',t("Search scope", '搜索范围'));for(const [id,label] of [['main',t("Main text", '正文')],['all',t("Entire book", '全书所有内容')],['extra',t("Additions & appendices", '原作补充与附录')],['note',t("Book notes", '书中注释')],['support',t("Supporting material", '支持资料')],['chapter',t("Current chapter", '当前章节')]]){const o=node('option','',label);o.value=id;scope.append(o);}scope.value=searchSession.scope;
    const lang=node('select');lang.setAttribute('aria-label',t("Search language", '搜索语言'));for(const [id,label] of importedBook?[['all',languageLabel()]]:[['all',t("Both languages", '中英文')],...languageOptions()]){const o=node('option','',label);o.value=id;lang.append(o);}lang.value=searchSession.language;lang.hidden=importedBook;
    const submit=button(t("Search", '搜索'),'primary-button');submit.type='submit';form.append(label,input,scope,lang,submit);root.append(form);
    const status=node('p','search-summary');status.setAttribute('role','status');const results=node('div','local-search-results');root.append(status,results);
    const run=(reset=false)=>{
      if(reset){searchSession={query:input.value.trim(),scope:scope.value,language:lang.value,limit:50,scroll:0};saveHistoryContext();}
      results.replaceChildren();const q=searchSession.query;
      if(!q.trim()){status.textContent=t("Enter a word or phrase to search.", '输入词句后开始搜索。');return;}
      if(!indexReady){status.textContent=t("The local index is not ready. Try again shortly.", '本地索引未就绪，请稍后重试。');return;}
      const started=performance.now(),lower=q.toLocaleLowerCase();
      const matched=searchIndex.filter(row=>{
        if(searchSession.language!=='all' && row.language!==searchSession.language)return false;
        const scope=searchSession.scope;
        if(scope==='note' && row.entityType!=='note')return false;
        if(scope==='chapter' && row.sectionId!==current.sectionId)return false;
        if(['main','extra','support'].includes(scope) && (row.entityType==='note' || scopeKind(sectionMap.get(row.sectionId))!==scope))return false;
        return row.text.toLocaleLowerCase().includes(lower);
      });
      status.textContent=matched.length?t(`${matched.length} results; showing the first ${Math.min(searchSession.limit,matched.length)}.`, `找到 ${matched.length} 项，显示前 ${Math.min(searchSession.limit,matched.length)} 项。`):t("No matching text. Try another phrase or scope.", '没有找到这段文字，可更换词句或范围。');
      for(const row of matched.slice(0,searchSession.limit)){
        const b=button('','local-search-result',()=>{
          searchSession.scroll=root.scrollTop;dom['search-return'].hidden=false;saveHistoryContext();
          if(row.unitId)showUnit(row.unitId,{language:row.language,blockId:row.blockId,noteId:row.entityType==='note'?row.entityId:undefined,reason:t("Local search", '本地搜索'),focus:true});else toast(t("This item has no accessible location. Find it in chapter notes.", '此条暂没有可访问位置，请从章节书注目录查看。'));
        });b.append(node('span','search-result-location',t(`${languageLabel(row.language)} · ${sectionTitle(sectionMap.get(row.sectionId),row.language)}${row.entityType==='note'?' · Note':''}`, `${languageLabel(row.language)} · ${sectionTitle(sectionMap.get(row.sectionId),row.language)}${row.entityType==='note'?' · 书注':''}`)),literalExcerpt(row,q));results.append(b);
      }
      if(matched.length>searchSession.limit)results.append(button(t("Show 50 more", '再显示50项'),'small-button',()=>{const y=root.scrollTop;searchSession.limit+=50;run();root.scrollTop=y;}));
      document.documentElement.dataset.lastSearchMs=(performance.now()-started).toFixed(2);
    };
    form.addEventListener('submit',event=>{event.preventDefault();run(true);});run();requestAnimationFrame(()=>{root.scrollTop=searchSession.scroll;});
  }
  function exportRecords() {
    savePosition();const value=store.export();const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const part=t=>parts.find(p=>p.type===t).value;
    const stamp=`${part('year')}${part('month')}${part('day')}_${part('hour')}${part('minute')}${part('second')}`,count=exportedNames.get(stamp)||0;exportedNames.set(stamp,count+1);
    const name=`redbook_records_${stamp}${count?'_'+count:''}.json`,url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);return name;
  }
  function renderRecords() {
    const root=dom['panel-content'];root.append(node('p','panel-intro',t("Records stay in this browser. Download a local backup. Book identity and format are checked before restore; canceling makes no changes.", '记录保存在此浏览器。备份由你下载到本机；恢复前先检查书籍、底本与数据格式，取消不会写入。')));
    root.append(node('p','records-counts',t(`Bookmarks ${state.favorites.length} · Notes ${Object.keys(state.notes).length} · Visited ${Object.keys(state.visited).length}`, `收藏 ${state.favorites.length} · 笔记 ${Object.keys(state.notes).length} · 访问 ${Object.keys(state.visited).length}`)));
    root.append(button(t("Export backup", '导出记录备份'),'primary-button',()=>{exportRecords();toast(t("Backup download started. Keep the file safe.", '已发起本地备份下载，请保管文件。'));}));
    const label=node('label','import-label',t("Choose a backup (JSON, up to 10 MiB)", '选择记录备份（JSON，最多10MiB）'));const input=node('input');input.type='file';input.accept='.json,application/json';input.id='records-file';label.htmlFor=input.id;
    root.append(label,input);const previewBox=node('div','restore-preview');root.append(previewBox);
    input.addEventListener('change',async()=>{
      importPreview=null;previewBox.replaceChildren();const file=input.files?.[0];if(!file)return;
      try {
        if(file.size>10*1024*1024)throw Error(t("Backup exceeds 10 MiB", '备份文件超过10MiB'));
        importPreview=store.preview(await file.text());
        previewBox.append(node('h3','',t("Restore preview", '恢复预检')),node('p','',t(`New ${importPreview.added} · Duplicates ${importPreview.duplicate} · Note conflicts ${importPreview.conflicts} · Unmatched ${importPreview.orphans}`, `新增 ${importPreview.added} · 重复 ${importPreview.duplicate} · 笔记冲突 ${importPreview.conflicts} · 孤立记录 ${importPreview.orphans}`)));
        if(importPreview.differentDataset)previewBox.append(node('p','panel-intro',t("Same source edition, different data version. Stable identifiers were checked; unmatched records will be preserved separately.", '底本相同，数据版本不同。已按稳定标识和明确别名检查；不能定位的记录会保留在孤立记录中。')));
        const restoreLabel=node('label','checkbox-label'),restore=node('input');restore.type='checkbox';restoreLabel.append(restore,document.createTextNode(t("Also restore current position, today’s passage and reading positions", '同时恢复备份的当前位置、今日与阅读位置')));previewBox.append(restoreLabel);
        let restoring=false;
        const apply=async(replace)=>{if(restoring)return;restoring=true;try{if(pausedPosition)throw Error(t("Close artwork or other overlays before restoring records", '请先关闭原画或其他覆盖层后恢复记录'));state=await store.apply(importPreview,{replace,restorePosition:restore.checked});importPreview=null;const id=unitById(state.current?.unitId)?state.current.unitId:current.id;showUnit(id,{language:state.current?.language,restore:true,initial:true,reason:t("Restore records", '恢复记录')});openPanel('records');toast(t("Records restored and verified.", '记录已恢复并回读验证。'));}catch(error){refreshStorageNotice();previewBox.append(node('p','form-error',recordNotice(error.message)));}finally{restoring=false;}};
        previewBox.append(button(t("Merge backup", '合并恢复'),'small-button',()=>apply(false)));
        const replace=button(t("Replace all records", '替换恢复全部记录'),'small-button',()=>apply(true));replace.disabled=true;
        previewBox.append(button(t("Download current backup to enable replacement", '先下载当前备份，再启用替换'),'small-button',()=>{exportRecords();replace.disabled=false;}),replace);
        previewBox.append(button(t("Cancel restore", '取消恢复'),'text-button',()=>{importPreview=null;input.value='';previewBox.replaceChildren(node('p','panel-intro',t("Canceled. Existing records are unchanged.", '已取消，现有记录未改动。')));}));
      }catch(error){previewBox.append(node('p','form-error',t(`Unable to restore: ${recordNotice(error.message)}. Existing records are unchanged.`, `无法恢复：${recordNotice(error.message)}。现有记录未改动。`)));}
    });
    const conflicts=state.conflicts || [];
    if(conflicts.length){const section=node('section','record-conflicts');section.append(node('h3','',t(`Unresolved note conflicts · ${conflicts.length}`, `待处理笔记冲突 · ${conflicts.length}`)));for(const [index,c]of conflicts.entries()){
      const entry=node('article','record-conflict');entry.append(node('p','result-meta',unitById(c.id)?preview(unitById(c.id)):c.id),node('h4','',t("Current note", '当前笔记')),node('p','record-text',c.local),node('h4','',t("Imported note", '导入笔记')),node('p','record-text',c.incoming));
      entry.append(button(t("Keep current note", '保留当前笔记'),'text-button',async()=>{const active=state.conflicts.indexOf(c);if(active<0)return;state.conflicts.splice(active,1);const ok=await persist();renderPanel();if(!ok)toast(t("Conflict choice is not saved yet. Export a backup from this page.", '冲突选择尚未保存，请导出本页备份。'));}),button(t("Use imported note", '采用导入笔记'),'text-button',async()=>{const active=state.conflicts.indexOf(c);if(active<0)return;state.notes[c.id]=c.incoming;state.conflicts.splice(active,1);const ok=await persist();updateRecordIndicator();renderPanel();if(!ok)toast(t("Conflict choice is not saved yet. Export a backup from this page.", '冲突选择尚未保存，请导出本页备份。'));}));section.append(entry);
    }root.append(section);}
    const orphans=state.orphans || [];
    if(orphans.length){const d=node('details','orphan-records');d.append(node('summary','',t(`Unmatched records · ${orphans.length}`, `暂无法定位的记录 · ${orphans.length}`)),node('p','panel-intro',t("Original identifiers and sources are preserved. Records are not reassigned by display order and remain in exported backups.", '保留原标识和底本。不会按显示序号绑定到别段；这些记录随备份导出。')));
      for(const o of orphans.slice(0,100)){const row=node('p','orphan-entry',t(`${o.kind} · ${o.id}\n${typeof o.value==='string'?o.value:JSON.stringify(o.value)}\nSource: ${Object.values(o.sourceShas || {}).map(v=>v.slice(0,12)).join(' / ')}`, `${o.kind} · ${o.id}\n${typeof o.value==='string'?o.value:JSON.stringify(o.value)}\n底本：${Object.values(o.sourceShas || {}).map(v=>v.slice(0,12)).join(' / ')}`));d.append(row);}if(orphans.length>100)d.append(node('p','panel-intro',t("Showing the first 100 items. Backups preserve all records.", '此处显示前100条，完整内容保留在备份中。')));root.append(d);}
    if(store.notice)root.append(node('p','form-error',recordNotice(store.notice)));
  }
  function prepareData() {
    schema2=data.schemaVersion===2;
    if(data.schemaVersion!==undefined && ![1,2].includes(data.schemaVersion))throw Error(t("Unsupported text data version. Personal records are unchanged.", '正文数据版本不支持；个人记录未修改。'));
    if(!Array.isArray(data.units)||!data.units.length)throw Error(t("No imported text found", '未找到已导入正文'));
    units=data.units.slice();unitMap=new Map();
    for(const u of units){if(typeof u.id!=='string'||unitMap.has(u.id))throw Error(t("Text contains duplicate or missing identifiers", '正文含重复或缺失的稳定标识'));if(!schema2&&(!u.zh?.length||!u.en?.length))throw Error(t("Legacy bilingual data is incomplete", '首批双语数据不完整'));unitMap.set(u.id,u);}
    if(schema2){
      if(!Array.isArray(data.sections)||!data.notesById||!data.imagesById)throw Error(t("Book data is missing chapter, note or image indexes", '全书数据缺少章节、书注或图像索引'));
      sections=data.sections;sectionMap=new Map();for(const sec of sections){if(sectionMap.has(sec.id))throw Error(t("Duplicate chapter identifier", '章节标识重复'));sectionMap.set(sec.id,sec);}
      for(const sec of sections){if(sec.parentId&&!sectionMap.has(sec.parentId))throw Error(t("Missing parent chapter", '章节父节点不存在'));let ancestor=sec,seen=new Set();while(ancestor){if(seen.has(ancestor.id))throw Error(t("Chapter hierarchy contains a cycle", '章节层级存在循环'));seen.add(ancestor.id);ancestor=sectionMap.get(ancestor.parentId);}for(const lang of ['zh','en']){if(!Array.isArray(sec.readingOrder?.[lang]))throw Error(t("Missing chapter language order", '章节语言顺序缺失'));for(const id of sec.readingOrder[lang])if(!unitMap.has(id)||unitMap.get(id).sectionId!==sec.id)throw Error(t("Chapter reference unavailable", '章节引用不可用'));for(const id of sec.noteIds?.[lang]||[])if(!data.notesById[id])throw Error(t("Chapter note reference unavailable", '章节书注引用不可用'));}}
      for(const u of units){if(!sectionMap.has(u.sectionId))throw Error(t("Passage chapter is missing", '单元章节不存在'));for(const id of [...(u.noteIds||[]),...(u.chapterNoteIds||[])]){if(!data.notesById[id])throw Error(t("Passage note reference unavailable", '单元书注引用不可用'));if(!noteOwners.has(id))noteOwners.set(id,u.id);}for(const id of u.imageIds||[])if(!data.imagesById[id])throw Error(t("Passage image reference unavailable", '单元图片引用不可用'));}
      const walk=(sec,lang)=>[...(sec.readingOrder[lang]||[]),...childrenOf(sec.id).flatMap(child=>walk(child,lang))];
      for(const lang of ['zh','en'])languageOrder[lang]=childrenOf().flatMap(sec=>walk(sec,lang));
    }else{
      units.sort((a,b)=>a.order-b.order);sections=[{id:'legacy',parentId:null,order:0,title:{zh:'第一卷 · 序言',en:'Liber Primus'},kind:'main',readingOrder:{zh:units.map(u=>u.id),en:units.map(u=>u.id)},noteIds:{zh:[],en:[]}}];sectionMap=new Map(sections.map(sec=>[sec.id,sec]));for(const u of units)u.sectionId='legacy';languageOrder={zh:units.map(u=>u.id),en:units.map(u=>u.id)};
    }
    for(const u of units)for(const lang of ['zh','en']){
      for(const p of u[lang]||[])blockOwners.set(p.id,{unitId:u.id,language:lang});
      for(const id of u.sourceBlockIds?.[lang]||[])blockOwners.set(id,{unitId:u.id,language:lang});
    }

    buildSearchIndex();
  }
  function exposeAdapter() {
    const resolveTarget=target=>{
      if(!target || typeof target!=='object')return null;
      let unit=target.unitId?unitById(target.unitId):null,lang=['zh','en'].includes(target.language)?target.language:language;
      if(target.unitId&&!unit)return null;
      const owner=target.blockId&&(blockOwners.get(target.blockId)||blockOwners.get(data.legacy?.blockAliases?.[target.blockId]));
      if(target.blockId&&!owner)return null;
      if(owner){if(unit&&owner.unitId!==unit.id)return null;unit=unitById(owner.unitId);lang=owner.language;}
      if(!unit&&target.sectionId)unit=unitById(sectionEntry(sectionMap.get(target.sectionId),lang));
      if(!unit)return null;return {...target,unitId:unit.id,language:unitLanguage(unit,lang)};
    };
    const openTarget=(target,options={})=>{
      const resolved=resolveTarget({...target,...(options.language?{language:options.language}:{})});if(!resolved)return false;
      return showUnit(resolved.unitId,{...resolved,...options,focus:options.focus!==false,reason:options.reason || t("Read passage linked to image", '图像关联阅读')});
    };
    const restoreAnchor=(value,options={})=>{
      const resolved=resolveTarget(value);if(!resolved)return false;
      if(current?.id===resolved.unitId && language===resolved.language){
        if(Object.hasOwn(options,'contextSnapshot') && JSON.stringify(contextState)!==JSON.stringify(options.contextSnapshot)){
          contextState=options.contextSnapshot?{...options.contextSnapshot}:null;renderInlineContext();
        }
        restoreView(resolved,{focus:options.focus!==false,viewport:options.viewport});return true;
      }
      return openTarget(resolved,{restore:true,reason:t("Restore reading position", '恢复阅读位置'),...options});
    };
    const publish=()=>{window.RedbookReader=Object.freeze({
      version:1,dataset,datasetId:data.metadata?.datasetId || null,imported:importedBook,readingSha256,
      getSourceUnit:id=>{const value=unitById(id);return value?structuredClone(value):null;},
      getSourceNote:id=>{const value=data.notesById?.[id];return value?structuredClone(value):null;},
      getAnchor:()=>anchor(),savePosition:()=>{savePosition();persist();return anchor();},
      // A short-lived closure, never part of a persisted stable anchor.
      captureViewport:()=>{stopContextMotion();const value=anchor();if(!value)return null;const contextSnapshot=contextState?{...contextState}:null;
        const viewport={unitId:current.id,language,top:scrollY,left:scrollX,width:document.documentElement.clientWidth,height:innerHeight,readerWidth:dom.reader.offsetWidth,readerHeight:dom.reader.scrollHeight,surface:contextState?captureReadingSurface():null,page:pageReader?.snapshot()};
        return (options={})=>restoreAnchor(value,{...options,viewport,contextSnapshot});},
      restoreAnchor,
      openTarget,openUnit:(unitId,options={})=>openTarget({unitId},options),openSection:(sectionId,options={})=>openTarget({sectionId},options),openBlock:(blockId,options={})=>openTarget({blockId},options),
      hasTarget:target=>Boolean(resolveTarget(target)),
      pausePositionWrites:()=>{savePosition();persist();pausedPosition++;let released=false;return ()=>{if(!released){pausedPosition=Math.max(0,pausedPosition-1);released=true;}};},
      captureFocus:()=>{const el=document.activeElement;return ()=>{if(el?.isConnected && el!==document.body && el!==document.documentElement && (!el.getClientRects || el.getClientRects().length))el.focus({preventScroll:true});else dom['chapter-zh'].focus({preventScroll:true});};},
      restoreFocus:target=>{if(target?.isConnected)target.focus({preventScroll:true});else dom['chapter-zh'].focus({preventScroll:true});}
    });
    if(!importedBook && window.ReadingDictionary && !readingDictionary)readingDictionary=window.ReadingDictionary.create({
      reading:data,readingBytes,reader:window.RedbookReader,
      renderNotes:(notes,target,owner,back)=>noteGroup(t("Edition notes", '版本书注'),notes,target,owner,back,t("Return to previous lookup", '返回上一层查阅')),
      onOpen:()=>{closePanel(false);openPanel('dictionary');},
      onClose:()=>{if(panel==='dictionary')closePanel(false);},
      onNotice:toast,
      onSessionChange:value=>{
        const bar=$('lookup-reading-return');if(!bar)return;
        bar.hidden=!value || value.visible;
        $('lookup-return').hidden=!value?.navigated;
      }
    });
    if(!importedBook && window.ReadingAids && !readingAids)readingAids=window.ReadingAids.init({data,readingBytes,reader:window.RedbookReader,renderUnit:(u,l,c)=>renderLanguage(u,l,c,true),renderNotes:(notes,target,owner,back)=>noteGroup(t("Edition notes", '版本书注'),notes,target,owner,back),openPanel:()=>openPanel('aids'),openDictionary:()=>readingDictionary?.openDictionary(),openChapter:(sectionId,l)=>readingDictionary?.openChapter(sectionId,l),openEntry:entryId=>readingDictionary?.openBaseEntry(entryId),refresh:()=>{
      if(!current)return;
      const restore=window.RedbookReader?.captureViewport(),focused=document.activeElement;
      const binding=dom.reader.contains(focused)?focused?.dataset?.aidBinding:null;
      renderReadingColumns();
      if(restore)restore({focus:false});
      if(binding)requestAnimationFrame(()=>dom.reader.querySelector(`[data-aid-binding="${CSS.escape(binding)}"]`)?.focus({preventScroll:true}));
    }});
    window.dispatchEvent(new CustomEvent('redbook:reader-ready',{detail:{version:1,dataset,datasetId:data.metadata?.datasetId || null}}));};
    requestAnimationFrame(()=>requestAnimationFrame(publish));
  }

  function bindEvents() {
    pageReader=window.ReadingPages?.create({onTurn:()=>{savePosition();persist();}}) || null;
    $('lookup-return').addEventListener('click',()=>readingDictionary?.returnToOrigin());
    $('lookup-reopen').addEventListener('click',()=>{const value=readingDictionary?.getSessionState();if(value)readingDictionary.open({sectionId:value.ui.sectionId});});
    $('lookup-continue').addEventListener('click',()=>readingDictionary?.continueReading());
    $('reading-aids-open').addEventListener('click',()=>{if(readingAids)openPanel('aids');else toast(t("Reading tools are loading. Try again shortly.", '阅读辅助正在准备，请稍后再试。'));});
    $('context-toggle').addEventListener('click',()=>contextState?collapseContext():expandContext());
    $('context-collapse').addEventListener('click',collapseContext);
    $('context-origin').addEventListener('click',returnToContextOrigin);
    $('context-show-before').addEventListener('click',()=>scrollToContext($('context-before').querySelector('[data-context-group]')));
    $('context-show-after').addEventListener('click',()=>scrollToContext($('context-after').querySelector('[data-context-group]')));
    for(const id of ['artwork-open','artwork-return'])$(id)?.addEventListener('click',()=>{stopContextMotion();if(aidSession)closePanel();if(panel==='dictionary')readingDictionary?.dismiss();},true);
    dom['contents-button'].addEventListener('click',()=>openPanel('contents'));
    dom['search-button'].addEventListener('click',()=>openPanel('search'));
    dom['records-button'].addEventListener('click',()=>openPanel('records'));
    dom['chapter-notes-button'].addEventListener('click',()=>openPanel('chapterNotes'));
    dom['search-return'].addEventListener('click',()=>openPanel('search'));
    dom['language-select'].addEventListener('change',()=>{const wanted=dom['language-select'].value;dom['language-select'].value=language;readLanguage(wanted);});
    $('secondary-language-select').addEventListener('change',()=>{secondaryLanguage=$('secondary-language-select').value;saveLanguagePreference();const position=anchor();renderReadingColumns();updateLanguageTools();dom['notes-count'].textContent=visibleNotes().length;refreshPageNavigation();pageReader?.restore(position,null);});
    $('language-choose').addEventListener('click',()=>openPanel('language-chapter'));
    window.addEventListener('popstate',event=>{if(!store)return;const value=event.state?.anchor || readHash();if(event.state?.search){searchSession=event.state.search;dom['search-return'].hidden=!searchSession.query;}if(value)showUnit(value.unitId,{...value,restore:true,noHistory:true,reason:t("Browser navigation", '浏览器返回')});if(event.state?.panel==='search')openPanel('search');});
    window.addEventListener('hashchange',()=>{if(!store || location.hash===handledHash)return;const value=readHash();if(value && (value.unitId!==current?.id || value.language!==language || value.blockId))showUnit(value.unitId,{...value,noHistory:true,reason:t("Linked location", '链接定位')});});
    dom['previous-button'].addEventListener('click',() => pageReader?pageReader.turn(-1,()=>move(-1)):move(-1));
    dom['next-button'].addEventListener('click',() => pageReader?pageReader.turn(1,()=>move(1)):move(1));
    dom['random-button'].addEventListener('click',encounter);
    dom['favorite-button'].addEventListener('click',toggleFavorite);
    dom['today-button'].addEventListener('click',() => {
      if (!current) return;
      const today = dateKey();
      if (state.today.date !== today || !unitById(state.today.id)) {
        const next = nextRandomId() || current.id;
        state.today = {date:today,id:next};
        showUnit(next,{language:preferredLanguage,reason:t("Open today’s passage", '领取今日首段')});
        dom['today-number'].textContent = pad(unitById(next).order);
        persist();
      } else {const target=languageModel.resolve(unitById(state.today.id),preferredLanguage,{fallback:true});if(target)showUnit(target.id,{language:preferredLanguage,reason:t("Today’s passage", '今日首段'),restore:true});}
    });
    dom['history-button'].addEventListener('click',() => openPanel('history'));
    dom['record-button'].addEventListener('click',() => openPanel('record'));
    dom['source-button'].addEventListener('click',() => openPanel('source'));
    dom['notes-button'].addEventListener('click',() => openPanel('notes'));
    dom['related-button'].addEventListener('click',() => openPanel('related'));
    dom['panel-close'].addEventListener('click',() => closePanel());
    dom['back-top'].addEventListener('click',() => window.scrollTo({top:0,behavior:'instant'}));
    document.addEventListener('keydown',(event) => {
      if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))stopContextMotion();
      if (event.key === 'Escape' && panel) { event.preventDefault(); closePanel(); }
      else keepPanelFocus(event);
    });
    mobilePanelMedia.addEventListener('change',syncPanelMode);
    contextMotionMedia.addEventListener('change',stopContextMotion);
    for(const event of ['wheel','touchstart','pointerdown'])window.addEventListener(event,stopContextMotion,{passive:true});
    window.addEventListener('scrollend',()=>{contextSmoothScroll=false;});
    window.addEventListener('resize',updateContextRoute,{passive:true});
    window.addEventListener('scroll',() => {
      updateContextRoute();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {savePosition();persist();},180);
    }, {passive:true});
    window.addEventListener('pagehide',() => {savePosition();persist();});
    window.addEventListener('beforeunload',event => {if(store?.dirty){event.preventDefault();event.returnValue='';}persist();});
  }

  async function init() {
    bindEvents();
    if(window.matchMedia('(max-width:760px)').matches)dom['sequence-details'].open=false;
    try {
      if(importedBook && !/^(?:epub|pdf|txt|mobi|azw3|fb2)-[a-f0-9]{64}$/.test(bookId))throw Error(t("Invalid book link. Open the book from your local library.", '这本书的链接无效，请从本机书库重新打开。'));
      const readingURL=importedBook?`/api/library/${encodeURIComponent(bookId)}/reading.json`:dataset==='candidate'?'/candidate/reading.json':'/data/reading.json';
      const started=performance.now(), response=await fetch(readingURL,{cache:'no-cache'});
      if(!response.ok){
        if(!importedBook && dataset==='active' && response.status===404){location.replace('/library.html');return;}
        throw Error(importedBook && response.status===404?t("This book is absent from your local library. Import the original file again.", '这本书不在当前本机书库中，请重新导入原电子书。'):t(`Book data returned ${response.status}`, `正文文件返回 ${response.status}`));
      }
      readingBytes=await response.arrayBuffer();data=JSON.parse(new TextDecoder().decode(readingBytes));
      if(importedBook && (data.metadata?.bookId!==bookId || data.metadata?.imported!==true || !/^[a-f0-9]{64}$/.test(data.metadata?.datasetId || '') || !['zh','en'].includes(data.metadata?.primaryLanguage)))throw Error(t("Book identity could not be verified. Import it again from the library.", '电子书身份校验失败，请回书库重新导入。'));
      if(importedBook)language=data.metadata.primaryLanguage;
      readingSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',readingBytes)),x=>x.toString(16).padStart(2,'0')).join('');prepareData();await loadAlignment();prepareLanguage();applyBookIdentity();
      let storage;
      try{storage=recordMode==='session'?sessionStorage:localStorage;}catch(error){storage={getItem(){throw error;},setItem(){throw error;}};}
      let lockName;
      if(importedBook){
        const baseStorage=storage,prefix=`foliotter.library.${data.metadata.datasetId}.`;
        storage={getItem:key=>baseStorage.getItem(prefix+key),setItem:(key,value)=>baseStorage.setItem(prefix+key,value),removeItem:key=>baseStorage.removeItem(prefix+key)};
        lockName=prefix+'write';
      }
      if(recordMode==='session')lockName='redbook.reader.v2.session.'+crypto.randomUUID();
      store=window.RedbookRecords.open(data,{storage,readonly:recordMode==='readonly',...(lockName?{lockName}:{})});state=store.state;storageAvailable=store.available;
      refreshStorageNotice();
      for(const key of ['total-count','footer-total'])dom[key].textContent=units.length;dom['random-total'].textContent=randomPool.length;
      dom['dataset-label'].textContent=importedBook?t("My local library", '我的本机书库'):dataset==='candidate'?t("Candidate book preview", '全书候选预览'):t("Local reading", '本机阅读');
      dom['contents-button'].hidden=!schema2;dom['language-controls'].hidden=!schema2;
      dom['load-state'].hidden=true;
      const previousContext=history.state;if(previousContext?.search){searchSession=previousContext.search;dom['search-return'].hidden=!searchSession.query;}
      const requested=readHash(), valid=requested&&unitById(requested.unitId);
      if(requested&&!valid){dom['load-state'].hidden=false;dom['load-state'].replaceChildren(node('p','',t("This reading position does not exist.", '这个阅读位置不存在。')),button(t("Open contents", '打开目录'),'small-button',()=>{const id=unitById(state.current?.unitId)?.id || units[0].id;showUnit(id,{initial:true,restore:true});dom['load-state'].hidden=true;openPanel('contents');}));exposeAdapter();return;}
      const previous=unitById(state.current?.unitId);
      const start=valid?requested.unitId:languageModel.resolve(previous,preferredLanguage,{fallback:true})?.id || languageOrder[preferredLanguage][0] || units[0].id;
      const saved=state.positions[start] || {},locationValue=requested?{...saved,...requested}:{...(saved.language===preferredLanguage?saved:{}),language:preferredLanguage};if(requested?.blockId && requested.blockId!==saved.blockId)locationValue.offsetRatio=0;
      showUnit(start,{...locationValue,initial:true,restore:true,reason:t("Open book", '打开阅读')});exposeAdapter();if(previousContext?.panel==='search')openPanel('search');
      document.documentElement.dataset.firstRenderMs=(performance.now()-started).toFixed(2);
    }catch(error){
      dom['load-state'].classList.add('error');
      const library=node('a','small-button',t("Open local library", '打开本机书库'));library.href='/library.html';
      dom['load-state'].replaceChildren(node('p','',t("Unable to open this book.", '暂时无法打开这本书。')),node('p','panel-intro',error.message),library,button(t("Try again", '重新打开'),'small-button',()=>location.reload()));
    }
  }
  function refreshInterface(){
    if(!data || !current)return;
    const unit=current,section=currentSection(),position=anchor(),page=pageReader?.snapshot(),restoreContext=contextState?window.RedbookReader?.captureViewport():null;
    const active=document.activeElement,activeId=active?.id,selection=active && Number.isInteger(active.selectionStart)?[active.selectionStart,active.selectionEnd]:null;
    const panelScroll=dom['panel-content'].scrollTop;
    const note=panel==='record'?dom['panel-content'].querySelector('#personal-note'):null;
    if(note)state.notes[current.id]=note.value;
    const query=panel==='search'?dom['panel-content'].querySelector('#book-query'):null;
    const draft=query?query.value:null;
    const searchSelects=panel==='search'?[...dom['panel-content'].querySelectorAll('select')].map(select=>select.value):null;
    applyBookIdentity();refreshStorageNotice();
    dom['today-number'].textContent=state.today.date===dateKey()?t("Opened", '已领取'):t("Not opened", '待领取');
    dom['content-type'].textContent=importedBook?t("Original local book text", '本机电子书原文'):({author:t("Jung’s original work", '荣格原作'),'quoted-by-author':t("Text quoted by Jung", '荣格引用的原文'),editor:t("Editorial & publishing material", '编者与出版资料'),mixed:t("Mixed sources", '混合来源'),unknown:t("Attribution awaiting review", '来源归属待核')})[unit.authorship] || ({quotation:t("Opening quotation", '原作开场引文'),'author-inscription':t("Jung’s inscription", '荣格题记'),reflection:t("Jung’s text · reflections preserved", '荣格正文 · 保留反思')})[unit.contentType] || t("Complete original passage", '完整原段');
    dom['chapter-notes-button'].textContent=t(`All chapter notes · ${(section?.noteIds?.[language] || []).length}`,`本章全部书注 · ${(section?.noteIds?.[language] || []).length}`);
    dom['dataset-label'].textContent=importedBook?t('My local library','我的本机书库'):dataset==='candidate'?t('Candidate book preview','全书候选预览'):t('Local reading','本机阅读');
    const local=section?.readingOrder?.[language] || units.map(value=>value.id),index=local.indexOf(unit.id);
    dom['scope-label'].textContent=schema2?t(`${languageLabel()} · ${sectionTitle(section)} · Passage ${Math.max(0,index)+1}/${local.length}`,`${languageLabel()} · ${sectionTitle(section)} · 章内 ${Math.max(0,index)+1}/${local.length}`):t(`Liber Primus · First ${units.length} passages`,`第一卷 · 前 ${units.length} 个阅读单元`);
    document.title=t(`${sectionTitle(section) || pad(unit.order)} · ${importedBook?recordNotice(data.metadata.title):'The Red Book'} · Foliotter`,`${sectionTitle(section) || pad(unit.order)} · ${importedBook?recordNotice(data.metadata.title):'红书'} · 书獭`);
    contextMessage='';renderReadingColumns();updateLanguageTools();updateProgress();updateFavorite();renderIndex();
    if(panel){dom['panel-title'].textContent=panelTitle(panel);renderPanel();dom['panel-content'].scrollTop=panelScroll;
      const restoredQuery=dom['panel-content'].querySelector('#book-query');if(draft!==null && restoredQuery)restoredQuery.value=draft;
      if(searchSelects)[...dom['panel-content'].querySelectorAll('select')].forEach((select,index)=>{if(searchSelects[index]!==undefined)select.value=searchSelects[index];});
    }
    if(restoreContext)restoreContext({focus:false});else pageReader?.restore(position,page);
    if(activeId){const restored=dom['panel-content'].querySelector(`#${activeId}`) || $(activeId);restored?.focus({preventScroll:true});if(selection)restored?.setSelectionRange?.(...selection);}
  }
  window.FoliotterI18n?.subscribe(refreshInterface);
  init();
})();
