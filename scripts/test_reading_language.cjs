'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const {harness,fixture}=require('./test_reader_import.cjs');
const context={window:{}};vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../app/reading-language.js'),'utf8'),context);
const ReadingLanguage=context.window.ReadingLanguage;
function pairedBook(){
  const unit=(id,lang)=>({id,sectionId:'chapter',kind:'prose',randomEligible:lang==='zh',[lang]:[{id:id+'-p',text:lang==='en'?`Original English ${id}`:`原始中文 ${id}`}],noteIds:[],imageIds:[]});
  const data={schemaVersion:2,metadata:{datasetId:'f'.repeat(64),sources:[{language:'zh',sha256:'1'.repeat(64)},{language:'en',sha256:'2'.repeat(64)}]},units:[unit('z1','zh'),unit('z2','zh'),unit('z3','zh'),unit('e1','en'),unit('e2','en'),unit('e3','en')],sections:[{id:'chapter',kind:'main',title:{zh:'原始章节',en:'Original chapter'},chapterMatch:{status:'verified'},readingOrder:{zh:['z1','z2','z3'],en:['e1','e2','e3']},noteIds:{zh:[],en:[]}}],notesById:{},imagesById:{}};
  const pairing={schemaVersion:1,datasetId:data.metadata.datasetId,readingSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),groups:[1,2].map(n=>({id:'g'+n,sectionId:'chapter',status:'reviewed',zh:['z'+n],en:['e'+n],review:{method:'agent-source-reading',reviewer:'synthetic-reviewer',evidence:'synthetic-fixture'}}))};
  return {data,pairing};
}
function change(app,id,value){const el=app.get(id);el.value=value;for(const fn of el.listeners.change || [])fn({target:el});}

test('default reading is English only, with a verified English random pool',async()=>{
  const {data,pairing}=pairedBook(),app=await harness(data,{query:'?records=session',pairing});
  assert.equal(app.get('reader').hidden,false,app.get('load-state').textContent);
  const reader=app.window.__readerTest;
  assert.equal(reader.getLanguage(),'en');assert.equal(reader.getPreferred(),'en');assert.equal(reader.getSecondary(),'off');
  assert.equal(app.get('zh-content').closest('.language-column').hidden,true);
  assert.equal(app.get('en-content').closest('.language-column').hidden,false);
  assert.deepEqual([...reader.getPool()],['e1','e2']);
  for(let n=0;n<12;n++){reader.encounter();assert.equal(reader.getLanguage(),'en');assert.match(app.get('en-content').textContent,/Original English/);assert.equal(app.get('zh-content').closest('.language-column').hidden,true);}
});

test('explicit pairing follows primary order; unpaired passages and context never reserve a blank column',async()=>{
  const {data,pairing}=pairedBook(),app=await harness(data,{query:'?records=session',pairing});
  const reader=app.window.__readerTest;
  change(app,'secondary-language-select','zh');
  assert.equal(app.get('en-content').closest('.language-column').style.order,'0');
  assert.equal(app.get('zh-content').closest('.language-column').style.order,'1');
  assert.equal(app.get('zh-content').closest('.language-column').hidden,false);
  reader.readLanguage('zh');
  assert.equal(reader.getLanguage(),'zh');assert.equal(reader.getSecondary(),'en');
  assert.equal(app.get('zh-content').closest('.language-column').style.order,'0');
  assert.equal(app.get('en-content').closest('.language-column').style.order,'1');
  reader.showUnit('z3',{language:'zh'});
  assert.equal(app.get('en-content').closest('.language-column').hidden,true);
  assert.match(app.get('language-reading-status').textContent,/No verified counterpart/);
  const row=reader.renderContextRow({id:'unpaired',zh:[data.units[2]],en:[]},'after');
  assert.equal(row.querySelectorAll('.context-column').length,1);
  assert.equal(row.querySelectorAll('.context-unpaired').length,0);
  change(app,'secondary-language-select','off');
  const pairedRow=reader.renderContextRow({id:'paired',zh:[data.units[0]],en:[data.units[3]]},'before');
  assert.equal(pairedRow.querySelectorAll('.context-column').length,1);
});

test('Chinese-only books use their available language and never offer a fake translation',async()=>{
  const app=await harness(fixture('b','zh'));
  assert.equal(app.window.__readerTest.getLanguage(),'zh');
  assert.equal(app.get('en-content').closest('.language-column').hidden,true);
  assert.equal(app.get('zh-content').closest('.language-column').hidden,false);
  assert.equal(app.get('comparison-controls').hidden,true);
  assert.equal(app.get('language-select').disabled,true);
  app.window.__readerTest.encounter();assert.equal(app.window.__readerTest.getLanguage(),'zh');
});

test('old Chinese reading records do not override the new English default; explicit links still work',async()=>{
  const {data,pairing}=pairedBook(),values=new Map();
  const previous=await harness(data,{query:'',pairing,values});
  previous.window.__readerTest.showUnit('z2',{language:'zh'});await previous.window.__readerTest.persist();
  const reopened=await harness(data,{query:'',pairing,values});
  assert.equal(reopened.window.__readerTest.getLanguage(),'en');
  assert.equal(reopened.window.__readerTest.getState().current.unitId,'e2');
  const linked=await harness(data,{query:'?records=readonly',pairing,values,hash:'#unit=z3&lang=zh'});
  assert.equal(linked.window.__readerTest.getLanguage(),'zh');assert.equal(linked.window.__readerTest.getState().current.unitId,'z3');
});

test('UI locale changes preserve reading language, source text, note drafts and cursor',async()=>{
  const app=await harness(fixture()),reader=app.window.__readerTest;
  reader.openPanel('record');
  const note=app.get('panel-content').querySelector('#personal-note');
  note.value='My note 中文 — original draft';note.selectionStart=3;note.selectionEnd=7;note.focus();
  for(const fn of note.listeners.input)await fn();
  const before=app.get('en-content').textContent,source=JSON.stringify(fixture());
  app.window.FoliotterI18n.setLocale('zh');
  const restored=app.get('panel-content').querySelector('#personal-note');
  assert.equal(restored.value,'My note 中文 — original draft');assert.equal(restored.selectionStart,3);assert.equal(restored.selectionEnd,7);
  assert.equal(reader.getLanguage(),'en');assert.equal(app.get('en-content').textContent,before);
  assert.equal(app.get('panel-title').textContent,'我的记录');assert.match(app.get('scope-label').textContent,/章内/);assert.equal(JSON.stringify(fixture()),source);
});

test('switching UI locale keeps unsubmitted search input and selected scope',async()=>{
  const app=await harness(fixture()),reader=app.window.__readerTest;
  reader.openPanel('search');
  const root=app.get('panel-content'),input=root.querySelector('#book-query');input.value='Not submitted 中文';input.selectionStart=4;input.selectionEnd=4;input.focus();
  root.querySelectorAll('select')[0].value='chapter';
  app.window.FoliotterI18n.setLocale('zh');
  assert.equal(root.querySelector('#book-query').value,'Not submitted 中文');assert.equal(root.querySelectorAll('select')[0].value,'chapter');
  assert.equal(root.querySelector('#book-query').selectionStart,4);assert.equal(reader.getLanguage(),'en');
});

test('read preferences are separate per book and persist without changing UI locale',async()=>{
  const {data,pairing}=pairedBook(),values=new Map(),app=await harness(data,{query:'',pairing,values});
  app.window.__readerTest.readLanguage('zh');
  assert.equal(app.window.FoliotterI18n.getLocale(),'en');
  assert(values.has(`foliotter.reading-language.${data.metadata.datasetId}`));
  const reopened=await harness(data,{query:'',pairing,values});assert.equal(reopened.window.__readerTest.getLanguage(),'zh');
  const another=await harness(fixture(),{values});assert.equal(another.window.__readerTest.getLanguage(),'en');
});

test('random selection never invents a counterpart when a source has none',()=>{
  const {data,pairing}=pairedBook(),getGroup=id=>pairing.groups.find(group=>group.zh.includes(id)||group.en.includes(id));
  const model=ReadingLanguage.create(data,{getGroup});
  assert.deepEqual([...model.randomPool('en')],['e1','e2']);
  assert.deepEqual([...model.randomPool('zh')],['z1','z2','z3']);
  assert.equal(model.resolve(data.units[2],'en'),null);
  assert.deepEqual([...model.columns(data.units[2],'zh','en').languages],['zh']);
});
