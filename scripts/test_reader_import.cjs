'use strict';
// Real reader initialization and record persistence, with an in-memory DOM and
// storage. Browser layout and native file selection are verified separately.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const readerSource=fs.readFileSync(path.join(__dirname,'../app/reader.js'),'utf8');
const recordsSource=fs.readFileSync(path.join(__dirname,'../app/records.js'),'utf8');
const noticeSource=fs.readFileSync(path.join(__dirname,'../app/reader-notices.js'),'utf8');
const languageSource=fs.readFileSync(path.join(__dirname,'../app/reading-language.js'),'utf8');
const alignmentSource=fs.readFileSync(path.join(__dirname,'../app/reading-alignment.js'),'utf8');
const contextSource=fs.readFileSync(path.join(__dirname,'../app/reading-context.js'),'utf8');
const artworkSource=fs.readFileSync(path.join(__dirname,'../app/encounter.js'),'utf8');

function fixture(letter='a',language='en'){
  const sha=letter.repeat(64),slot=language==='zh'?'zh':'en',id=`epub-${sha}`;
  return {schemaVersion:2,metadata:{bookId:id,datasetId:sha,imported:true,title:`Original fixture ${letter}`,author:'Fixture author',language,primaryLanguage:slot,sources:[{language:slot,sha256:sha}]},
    units:[1,2].map(n=>({id:`${id}-u${n}`,order:n,sectionId:'chapter',kind:'prose',[slot]:[{id:`${id}-p${n}`,text:`Original test paragraph ${n}`,language}],noteIds:[],imageIds:[]})),
    sections:[{id:'chapter',kind:'main',title:{zh:'Test chapter',en:'Test chapter'},readingOrder:{zh:[],en:[],[slot]:[`${id}-u1`,`${id}-u2`]},noteIds:{zh:[],en:[]}}],notesById:{},imagesById:{}};
}

async function harness(data,{values=new Map(),query=`?book=${data.metadata.bookId}`,missing=false,pairing=null,locale='en',hash=''}={}){
  const elements=new Map(),selectors=new Map(),requests=[],lockNames=[],frames=[];
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.style={};this.hidden=false;this.listeners={};this.className='';this._text='';this.scrollTop=0;this.offsetWidth=800;this.scrollHeight=500;}
    get classList(){return {add:(...v)=>{this.className=[this.className,...v].join(' ').trim();},remove:(...v)=>{this.className=this.className.split(' ').filter(x=>!v.includes(x)).join(' ');},toggle:(v,on)=>{if(on)this.classList.add(v);else this.classList.remove(v);}};}
    set textContent(v){this._text=String(v);this.children=[];}
    get textContent(){return this._text+this.children.map(x=>x.textContent||'').join('');}
    append(...items){this.children.push(...items);for(const item of items)item.parent=this;}
    replaceChildren(...items){this._text='';this.children=[];this.append(...items);}
    setAttribute(k,v){this.attributes[k]=String(v);}
    removeAttribute(k){delete this.attributes[k];}
    addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
    matches(s){return s.startsWith('#')?this.id===s.slice(1):s==='select'?this.tagName==='SELECT':s.startsWith('.')?this.className.split(' ').includes(s.slice(1)):s.startsWith('[data-')?Object.hasOwn(this.dataset,s.slice(6,-1).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())):false;}
    querySelectorAll(s){return this.children.flatMap(x=>[...(x.matches?.(s)?[x]:[]),...(x.querySelectorAll?.(s)||[])]);}
    querySelector(s){return this.querySelectorAll(s)[0]||null;}
    closest(s){for(let p=this;p;p=p.parent)if(p.matches(s))return p;return null;}
    contains(x){return this===x||this.children.some(p=>p.contains?.(x));}
    focus(){document.activeElement=this;}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    getBoundingClientRect(){return {top:100,bottom:200,height:100,width:500};}
    getClientRects(){return this.hidden?[]:[this.getBoundingClientRect()];}
  }
  const get=id=>{if(!elements.has(id)){const el=new Element();el.id=id;elements.set(id,el);}return elements.get(id);};
  const select=s=>{if(!selectors.has(s)){const el=new Element();el.className=s.slice(1);selectors.set(s,el);}return selectors.get(s);};
  const spread=select('.bilingual');
  for(const lang of ['zh','en']){const column=new Element('section');column.className='language-column';column.append(get(`${lang}-content`));spread.append(column);}
  get('reader').append(spread);get('reader').hidden=true;get('detail-panel').hidden=true;
  const document={activeElement:null,body:new Element('body'),documentElement:new Element('html'),getElementById:get,querySelector:select,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),addEventListener(){}};
  const location={search:query,hash,href:`http://127.0.0.1:8765/${query}`,replace:value=>{location.redirect=value;}};
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const events=new Map();
  const window={matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener:(type,fn)=>{(events.get(type)||events.set(type,[]).get(type)).push(fn);},dispatchEvent:event=>{for(const fn of events.get(event.type)||[])fn(event);},scrollTo(){},ReadingAids:{init(){throw Error('Private reading aids were initialized');}},ReadingDictionary:{create(){throw Error('Private dictionary was initialized');}}};
  const localeListeners=[];window.FoliotterI18n={text:(en,zh)=>locale==='zh'?zh:en,getLocale:()=>locale,subscribe:fn=>localeListeners.push(fn),setLocale:value=>{locale=value;localeListeners.forEach(fn=>fn(value));}};
  if(!data.metadata.imported){delete window.ReadingAids;delete window.ReadingDictionary;}
  const history={state:null,replaceState(state,_,url){this.state=state;if(url?.startsWith('#'))location.hash=url;},pushState(state,_,url){this.replaceState(state,_,url);}};
  const context={document,window,history,location,localStorage:storage,sessionStorage:storage,URLSearchParams,URL,TextDecoder,TextEncoder,crypto:webcrypto,performance,Intl,structuredClone,AbortController,console,
    navigator:{locks:{request:async(name,_options,fn)=>{lockNames.push(name);return fn({name});}}},
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},setTimeout,clearTimeout,
    CustomEvent:class{constructor(type,detail){this.type=type;this.detail=detail;}},scrollY:0,scrollX:0,innerHeight:900,
    fetch:async url=>{requests.push(url);if(missing)return {ok:false,status:404};if(url==='/data/reading-alignment.json')return {ok:Boolean(pairing),status:404,json:async()=>pairing};if(url.startsWith('/api/related'))return {ok:true,json:async()=>({dataset:'active',datasetId:data.metadata.datasetId,unitId:new URL(url,'http://localhost').searchParams.get('unit'),status:'unavailable',reason:'target_missing',results:[]})};const bytes=new TextEncoder().encode(JSON.stringify(data));return {ok:true,arrayBuffer:async()=>bytes.buffer};}};
  vm.createContext(context);vm.runInContext(recordsSource,context);vm.runInContext(noticeSource,context);vm.runInContext(languageSource,context);vm.runInContext(alignmentSource,context);vm.runInContext(contextSource,context);window.ReadingAlignment=context.ReadingAlignment;window.ReadingContext=context.ReadingContext;
  const seam='  init();\n})();';assert(readerSource.includes(seam));
  vm.runInContext(readerSource.replace(seam,'  window.__init=init(); window.__readerTest={persist,showUnit,toggleFavorite,encounter,readLanguage,renderContextRow,openPanel,getLanguage:()=>language,getPreferred:()=>preferredLanguage,getSecondary:()=>secondaryLanguage,getPool:()=>randomPool,getState:()=>state};\n})();'),context);
  vm.runInContext(artworkSource,context);
  await window.__init;
  while(frames.length){frames.splice(0).forEach(fn=>fn());}
  await window.__readerTest.persist();
  return {get,select,requests,values,window,document,location,lockNames};
}

test('imported foreign-language book stays monolingual and never fetches private book resources',async()=>{
  const data=fixture('a','fr'),app=await harness(data);
  assert.deepEqual(app.requests,[`/api/library/${data.metadata.bookId}/reading.json`]);
  assert.equal(app.get('reader').hidden,false,app.get('load-state').textContent);
  assert.equal(app.get('zh-content').closest('.language-column').hidden,true);
  assert.equal(app.get('en-content').closest('.language-column').hidden,false);
  assert.match(app.get('en-title').textContent,/French/);
  assert.match(app.get('en-content').textContent,/Original test paragraph 1/);
  assert.equal(app.select('.book-author').textContent,'Fixture author');
  assert.equal(app.select('.book-title .title-zh').textContent,'Original fixture a');
  for(const id of ['artwork-open','reading-aids-open','context-toggle','related-button','chapter-notes-button'])assert.equal(app.get(id).hidden,true,id);
  assert.equal(app.window.RedbookReader.imported,true);
});

test('two imported books keep separate positions, favorites and locks without touching old records',async()=>{
  const values=new Map([['redbook.reader.v1','PRIVATE LEGACY RECORD'],['redbook.reader.v2','PRIVATE LEGACY RECORD V2']]);
  const a=fixture('a'),b=fixture('b','zh'),first=await harness(a,{values});
  await first.window.__readerTest.toggleFavorite();
  first.window.__readerTest.showUnit(a.units[1].id,{initial:true});await first.window.__readerTest.persist();
  const second=await harness(b,{values});
  assert.equal(second.window.__readerTest.getState().favorites.length,0);
  assert.equal(second.window.__readerTest.getState().current.unitId,b.units[0].id);
  const restored=await harness(a,{values});
  assert.equal(restored.window.__readerTest.getState().current.unitId,a.units[1].id);
  assert.equal(restored.window.__readerTest.getState().favorites[0],a.units[0].id);
  assert.equal(values.get('redbook.reader.v1'),'PRIVATE LEGACY RECORD');
  assert.equal(values.get('redbook.reader.v2'),'PRIVATE LEGACY RECORD V2');
  assert.notEqual(first.lockNames[0],second.lockNames[0]);
  assert.equal([...values.keys()].filter(k=>k.endsWith('redbook.reader.v2')).length,3);
});

test('invalid or missing imported book never falls back to private book data',async()=>{
  const invalid=await harness(fixture(),{query:'?book=../../data/reading.json'});
  assert.deepEqual(invalid.requests,[]);assert.match(invalid.get('load-state').textContent,/Invalid book link/);
  const missing=await harness(fixture(),{missing:true});
  assert.equal(missing.requests.length,1);assert.match(missing.get('load-state').textContent,/absent from your local library/);
  assert(missing.get('load-state').children.some(x=>x.href==='/library.html'));
});

test('legacy metadata placeholders follow UI locale without translating real titles or authors',async()=>{
  for(const author of ['作者未注明','作者未标注']){
    const data=fixture();data.metadata.title='未命名电子书';data.metadata.author=author;
    const original=JSON.stringify(data),app=await harness(data);
    assert.equal(app.select('.book-title .title-zh').textContent,'Untitled book');
    assert.equal(app.select('.book-author').textContent,'Author not provided');
    assert.equal(app.document.title,'Test chapter · Untitled book · Foliotter');
    app.window.__readerTest.openPanel('source');
    assert.match(app.get('panel-content').textContent,/Untitled bookAuthorAuthor not provided/);
    app.window.FoliotterI18n.setLocale('zh');
    assert.equal(app.select('.book-title .title-zh').textContent,'未命名电子书');
    assert.equal(app.select('.book-author').textContent,author);
    assert.equal(app.document.title,'Test chapter · 未命名电子书 · 书獭');
    assert(app.get('panel-content').textContent.includes('作者'+author));
    app.window.FoliotterI18n.setLocale('en');
    assert.equal(app.document.title,'Test chapter · Untitled book · Foliotter');
    assert.equal(JSON.stringify(data),original);
  }
  const data=fixture();data.metadata.title='未命名电子书：原书名';data.metadata.author='作者未注明身份的真实作者';
  const original=JSON.stringify(data),app=await harness(data);
  app.window.__readerTest.openPanel('source');
  for(const locale of ['en','zh']){
    app.window.FoliotterI18n.setLocale(locale);
    assert.equal(app.select('.book-title .title-zh').textContent,data.metadata.title);
    assert.equal(app.select('.book-author').textContent,data.metadata.author);
    assert(app.document.title.includes(data.metadata.title));
    assert(app.get('panel-content').textContent.includes(data.metadata.author));
  }
  assert.equal(JSON.stringify(data),original);
});

module.exports={fixture,harness};
