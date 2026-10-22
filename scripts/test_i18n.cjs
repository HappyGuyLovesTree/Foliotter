'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../app',name),'utf8');
const i18nSource=read('i18n.js'),librarySource=read('library.js');
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function harness({storage=new Map(),storageBlocked=false,capabilities=null,library=false,bookMetadata={}}={}){
  const all=[],byId=new Map(),events=new Map(),requests=[];
  class Element{
    constructor(tag='div'){this.tagName=tag;this.attrs={};this.dataset={};this.children=[];this.listeners={};this.value='';this.files=[];this.hidden=false;this.disabled=false;this._text='';this.classes=new Set();this.classList={toggle:(name,value)=>value?this.classes.add(name):this.classes.delete(name)};all.push(this);}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(child=>child.textContent||'').join('');}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this._text='';this.children=[];this.append(...items);}
    setAttribute(name,value){this.attrs[name]=String(value);}
    getAttribute(name){return this.attrs[name]??null;}
    matches(selector){return [...selector.matchAll(/\[([^\]]+)\]/g)].every(([,attribute])=>Object.hasOwn(this.attrs,attribute));}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches?.(selector)?[child]:[]),...(child.querySelectorAll?.(selector)||[])]);}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    emit(name){return Promise.all((this.listeners[name]||[]).map(fn=>fn({target:this,preventDefault(){}})));}
    focus(){this.focused=true;}
    click(){return this.emit('click');}
  }
  const get=id=>{if(!byId.has(id)){const el=new Element();el.id=id;byId.set(id,el);}return byId.get(id);};
  const document={readyState:'complete',documentElement:new Element('html'),getElementById:get,querySelectorAll:selector=>all.filter(node=>node.matches(selector)),createElement:tag=>new Element(tag),addEventListener(){}};
  const label=get('marked');label.setAttribute('data-ui-en','Read');label.setAttribute('data-ui-zh','阅读');label.textContent='阅读';
  const button=get('button');button.setAttribute('data-ui-aria-label-en','Open library');button.setAttribute('data-ui-aria-label-zh','打开书库');
  const input=get('search');input.setAttribute('data-ui-placeholder-en','Search');input.setAttribute('data-ui-placeholder-zh','搜索');
  const content=get('book-source');content.textContent='阅读：用户的原文 / the source';
  const localeSelect=get('library-ui-language');localeSelect.setAttribute('data-ui-locale','');
  const fileButton=get('choose-file-button');fileButton.setAttribute('data-ui-en','Choose file');fileButton.setAttribute('data-ui-zh','选择文件');
  const context={document,console,Intl,URL,URLSearchParams,TextEncoder,TextDecoder,encodeURIComponent,location:{assign:value=>{context.target=value;}},
    localStorage:{getItem:key=>{if(storageBlocked)throw Error('blocked');return storage.get(key)||null;},setItem:(key,value)=>{if(storageBlocked)throw Error('blocked');storage.set(key,value);}},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    window:{addEventListener:(name,fn)=>{(events.get(name)||events.set(name,[]).get(name)).push(fn);},dispatchEvent:event=>{for(const fn of events.get(event.type)||[])fn(event);}},
    fetch:async(url,options)=>{requests.push({url,options});if(url==='/api/library')return {ok:true,json:async()=>({books:[{id:'epub-'+ 'a'.repeat(64),title:'中文原书名',author:'原作者',language:'fr',chapterCount:2,...bookMetadata}],legacyAvailable:false})};if(url==='/api/library/capabilities')return {ok:true,json:async()=>capabilities||{maxBytes:60*1024*1024,formats:[{extension:'epub',label:'EPUB',available:true},{extension:'txt',label:'TXT',available:true},{extension:'pdf',label:'PDF',available:false}],setupCommand:'python3 scripts/setup_importers.py --ensure'}};return {ok:true,json:async()=>({book:{id:'txt-'+'b'.repeat(64)}})};}};
  vm.createContext(context);vm.runInContext(i18nSource,context);
  if(library)vm.runInContext(librarySource,context);
  return {get,document,context,storage,requests,events,api:context.window.FoliotterI18n,content};
}

test('English is the default; only explicitly marked UI text and attributes change',()=>{
  const app=harness();assert.equal(app.api.getLocale(),'en');assert.equal(app.document.documentElement.lang,'en');assert.equal(app.get('marked').textContent,'Read');assert.equal(app.get('button').getAttribute('aria-label'),'Open library');assert.equal(app.get('search').getAttribute('placeholder'),'Search');assert.equal(app.content.textContent,'阅读：用户的原文 / the source');
});
test('language selection persists across pages, updates selectors once and preserves source content',async()=>{
  const app=harness(),notifications=[];const unsub=app.api.subscribe(value=>notifications.push(value));app.api.apply();app.api.apply();assert.equal(app.get('library-ui-language').listeners.change.length,1);
  app.get('library-ui-language').value='zh';await app.get('library-ui-language').emit('change');assert.equal(app.get('marked').textContent,'阅读');assert.equal(app.get('button').getAttribute('aria-label'),'打开书库');assert.equal(app.document.documentElement.lang,'zh-CN');assert.equal(app.storage.get('foliotter.ui.locale'),'zh');assert.deepEqual(notifications,['zh']);
  const other=harness({storage:app.storage});assert.equal(other.api.getLocale(),'zh');assert.equal(other.get('library-ui-language').value,'zh');assert.equal(app.content.textContent,'阅读：用户的原文 / the source');unsub();app.api.setLocale('en');assert.deepEqual(notifications,['zh']);
});
test('storage events synchronize tabs and unavailable storage still allows a session choice',()=>{
  const app=harness();for(const fn of app.events.get('storage'))fn({key:'foliotter.ui.locale',newValue:'zh'});assert.equal(app.api.getLocale(),'zh');assert.equal(app.get('marked').textContent,'阅读');const blocked=harness({storageBlocked:true});blocked.api.setLocale('zh');assert.equal(blocked.api.getLocale(),'zh');assert.throws(()=>blocked.api.setLocale('fr'),/Unsupported/);assert.equal(blocked.api.getLocale(),'zh');
});
test('multi-format library blocks unavailable dependencies and retains untranslated book metadata',async()=>{
  const app=harness({library:true});await settle();assert.match(app.get('format-capabilities').textContent,/PDF need optional tools/);assert.match(app.get('book-list').textContent,/中文原书名/);assert.match(app.get('book-list').textContent,/原作者/);assert.match(app.get('book-list').textContent,/French/);
  app.get('epub-file').files=[{name:'scan.pdf',size:100}];await app.get('epub-file').emit('change');assert.equal(app.get('import-button').disabled,true);await app.get('epub-import-form').emit('submit');assert.equal(app.requests.filter(x=>x.options?.method==='POST').length,0);assert.match(app.get('import-status').textContent,/optional local importer/);
  app.api.setLocale('zh');assert.match(app.get('import-status').textContent,/可选本机导入工具/);assert.match(app.get('book-list').textContent,/中文原书名/);assert.match(app.get('book-list').textContent,/法语/);
});
test('available TXT uploads the actual file with encoded filename and selected UI language',async()=>{
  const app=harness({library:true});await settle();app.api.setLocale('zh');const file={name:'我的书 #1.txt',size:1024};app.get('epub-file').files=[file];await app.get('epub-file').emit('change');assert.equal(app.get('import-button').disabled,false);await app.get('epub-import-form').emit('submit');const request=app.requests.find(x=>x.options?.method==='POST');assert.equal(request.url,'/api/library/import');assert.equal(request.options.body,file);assert.equal(request.options.headers['X-File-Name'],encodeURIComponent(file.name));assert.equal(request.options.headers['X-UI-Language'],'zh');assert.equal(request.options.headers['Content-Type'],'application/octet-stream');assert.equal(app.context.target,'/?book=txt-'+'b'.repeat(64));
});

test('artwork guide labels follow the interface while guide and source text remain verbatim',()=>{
  const app=harness();vm.runInContext(read('artwork-guides.js'),app.context);
  const entry={imageId:'fixture',observation:'原始观察文字',sourceNote:'原始依据文字',reading:'原始读法文字',question:'原始问题文字',sources:[{type:'note',id:'n1',role:'context'}]};
  const reader={getSourceNote:()=>({language:'zh',paragraphs:['原书段落，不能翻译。'],source:{file:'original.xhtml'}})};
  const container=app.get('guide');container.dataset={};
  app.context.window.ArtworkGuides.render(container,entry,reader,()=>{});
  assert.match(container.textContent,/First, look/);assert.match(container.textContent,/原始观察文字/);assert.match(container.textContent,/原书段落，不能翻译。/);
  app.api.setLocale('zh');app.context.window.ArtworkGuides.render(container,entry,reader,()=>{});
  assert.match(container.textContent,/先看画面/);assert.match(container.textContent,/原始观察文字/);assert.match(container.textContent,/原书段落，不能翻译。/);
});

test('unavailable artwork labels and failure details update when interface language changes',async()=>{
  const app=harness();app.context.location={search:'',origin:'http://127.0.0.1:8787'};
  app.context.window.RedbookReader={version:1};
  app.context.fetch=async()=>({ok:false});
  vm.runInContext(read('encounter.js'),app.context);await settle();
  assert.equal(app.get('artwork-open').textContent,'Artwork unavailable');
  assert.equal(app.get('artwork-notice').textContent,'Could not read the artwork manifest');
  app.api.setLocale('zh');
  assert.equal(app.get('artwork-open').textContent,'原画暂不可用');
  assert.equal(app.get('artwork-notice').textContent,'原画清单无法读取');
  assert.equal(app.get('artwork-status').textContent,'原画暂不可用。可以关闭后继续正文阅读。');
  app.api.setLocale('en');
  assert.equal(app.get('artwork-status').textContent,'The artwork is unavailable. Close this view to continue reading.');
  assert.equal(app.get('artwork-read').disabled,true);
});

test('only exact generated metadata placeholders change with the interface',async()=>{
  for(const author of ['作者未注明','作者未标注','']){
    const app=harness({library:true,bookMetadata:{title:'未命名电子书',author}});await settle();
    assert.match(app.get('book-list').textContent,/Untitled book/);assert.match(app.get('book-list').textContent,/Author not provided/);
    app.api.setLocale('zh');assert.match(app.get('book-list').textContent,/未命名电子书/);assert.match(app.get('book-list').textContent,/作者未标注/);
  }
  const app=harness({library:true,bookMetadata:{title:'未命名电子书的故事',author:'作者未注明自己的名字'}});await settle();
  assert.match(app.get('book-list').textContent,/未命名电子书的故事/);assert.match(app.get('book-list').textContent,/作者未注明自己的名字/);
});

test('the localized file button opens the native input, preserves filenames and focuses errors',async()=>{
  const app=harness({library:true});await settle();let opens=0;app.get('epub-file').addEventListener('click',()=>opens++);
  assert.equal(app.get('choose-file-button').textContent,'Choose file');assert.equal(app.get('selected-file-name').textContent,'No file selected');
  await app.get('choose-file-button').click();assert.equal(opens,1);
  await app.get('epub-import-form').emit('submit');assert.equal(app.get('choose-file-button').focused,true);
  app.api.setLocale('zh');assert.equal(app.get('choose-file-button').textContent,'选择文件');assert.equal(app.get('selected-file-name').textContent,'尚未选择文件');
  app.get('epub-file').files=[{name:'真实文件名.txt',size:1024}];await app.get('epub-file').emit('change');
  assert.equal(app.get('selected-file-name').textContent,'真实文件名.txt');app.api.setLocale('en');assert.equal(app.get('selected-file-name').textContent,'真实文件名.txt');
  let complete;app.context.fetch=()=>new Promise(resolve=>{complete=resolve;});const submit=app.get('epub-import-form').emit('submit');await settle();
  assert.equal(app.get('choose-file-button').disabled,true);await app.get('choose-file-button').click();assert.equal(opens,1);
  complete({ok:false,json:async()=>({notice:'An original test failure.'})});await submit;
  assert.equal(app.get('choose-file-button').disabled,false);
  const html=read('library.html');assert.match(html,/<button id="choose-file-button" type="button" aria-describedby="import-help selected-file-name file-details"/);assert.match(html,/<input id="epub-file"[^>]+ hidden>/);
});
