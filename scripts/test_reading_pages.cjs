'use strict';
// Exercise navigation and restoration in the real page controller. Native CSS
// fragmentation is verified separately in the actual browser, including tables.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app/reading-pages.js'),'utf8');

function fixture({reduced=false}={}){
  const elements=new Map(),frames=new Map(),listeners={},animations=[];
  let sequence=0;
  class Element{
    constructor(id=''){
      this.id=id;this.hidden=false;this.dataset={};this.attributes={};this.clientWidth=400;
      this.clientHeight=300;this.scrollLeft=0;this.scrollTop=0;this.listeners={};this.children=[];
      this.style={setProperty:(k,v)=>{this.style[k]=v;}};
      const classes=new Set();this.classList={toggle:(name,on)=>on?classes.add(name):classes.delete(name),remove:name=>classes.delete(name)};
    }
    append(child){this.children.push(child);child.parent=this;}
    before(sibling){this.insertedBefore=sibling;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    setAttribute(name,value){this.attributes[name]=value;}
    removeAttribute(name){delete this.attributes[name];}
    getBoundingClientRect(){return {left:0,right:this.clientWidth,top:0,bottom:this.clientHeight,height:this.clientHeight};}
    closest(selector){return selector==='.language-column'?this.column:null;}
    querySelector(selector){return selector==='.parallel-empty'?null:null;}
    querySelectorAll(selector){return selector==='[data-source-paragraph]'?[this.block]:selector==='[data-reading-unit]'?[this.owner]:[];}
    contains(element){return element===this || this.children.includes(element);}
    focus(){document.activeElement=this;}
    click(){this.listeners.click?.({target:this});}
    animate(){const item={cancelled:false,cancel(){this.cancelled=true;},finished:new Promise(()=>{})};animations.push(item);return item;}
  }
  const get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
  const spread=get('spread');spread.clientWidth=832;spread.clientHeight=350;
  for(const language of ['zh','en']){
    const content=get(language+'-content');content.column=get(language+'-column');
    content.pages=language==='zh'?2:3;
    Object.defineProperty(content,'scrollWidth',{get(){return this.pages*400+(this.pages-1)*32;}});
    content.owner=new Element();content.owner.dataset.readingUnit=language+'-unit';
    content.block=new Element();content.block.dataset.sourceParagraph=language+'-block';
    content.owner.querySelectorAll=()=>[content.block];
    content.block.getClientRects=()=>{
      const translate=Number(/translateX\((-?[\d.]+)px\)/.exec(content.style.transform || '')?.[1] || 0);
      return Array.from({length:content.pages},(_,index)=>({left:index*432+translate,right:index*432+translate+400,top:0,bottom:260,height:260}));
    };
  }
  get('reader').hidden=false;get('detail-panel').hidden=true;get('book-navigation').hidden=true;
  const document={body:get('body'),activeElement:null,fonts:null,getElementById:get,
    createElement:()=>new Element(),querySelector:selector=>selector==='.bilingual'?spread:selector==='dialog[open]'?null:get(selector),
    addEventListener:(name,fn)=>listeners[name]=fn};
  const context={window:{},document,matchMedia:()=>({matches:reduced,addEventListener(){}}),
    ResizeObserver:class{observe(){}},requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id;},
    cancelAnimationFrame:id=>frames.delete(id),getComputedStyle:()=>({fontSize:'24px'})};
  vm.runInNewContext(source,context);
  let turns=0,advances=0;
  const reader=context.window.ReadingPages.create({onTurn:()=>turns++});
  reader.setGroup({key:'reviewed-group',unitId:'zh-unit',language:'zh',aligned:true,canPrevious:false,canNext:true});
  const flush=()=>{while(frames.size){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();}};
  flush();
  return {reader,get,animations,listeners,flush,turn:direction=>reader.turn(direction,()=>advances++),counts:()=>({turns,advances}),
    setGroup:value=>{reader.setGroup(value);flush();}};
}

test('one reviewed group uses the longer side, turns within it, then deliberately advances',()=>{
  const h=fixture();
  assert.equal(h.get('page-count').textContent,'Page 1 of 3');
  assert.equal(h.get('previous-button').disabled,true);
  h.turn(1);h.turn(1);
  assert.equal(h.get('page-count').textContent,'Page 3 of 3');
  assert.equal(h.get('zh-content').attributes['aria-hidden'],'true');
  assert.equal(h.get('en-content').attributes['aria-hidden'],'false');
  assert.equal(h.get('next-label').textContent,'Next passage');
  assert.deepEqual(h.counts(),{turns:2,advances:0});
  h.turn(1);assert.deepEqual(h.counts(),{turns:2,advances:1});
});

test('a temporary snapshot restores its group/page after navigation without cloning source nodes',()=>{
  const h=fixture(),original=h.get('zh-content').block;
  h.turn(1);const saved=h.reader.snapshot();
  h.setGroup({key:'other',unitId:'en-unit',language:'en',canPrevious:true,canNext:true});
  h.setGroup({key:'reviewed-group',unitId:'zh-unit',language:'zh',canPrevious:false,canNext:true});
  assert(h.reader.restore({blockId:'zh-block'},saved));
  assert.equal(h.get('page-count').textContent,'Page 2 of 3');
  assert.equal(h.get('zh-content').block,original);
  assert.equal(h.get('zh-content').insertedBefore.children[0],h.get('zh-content'));
});

test('continuous context temporarily releases pagination and returns to the same book page',()=>{
  const h=fixture();h.turn(1);
  h.reader.setContext(true);
  assert.equal(h.reader.active,false);assert.equal(h.get('zh-content').dataset.paginated,undefined);
  assert.equal(h.get('next-label').textContent,'Next passage');
  h.reader.setContext(false);
  assert.equal(h.reader.active,true);assert.equal(h.get('page-count').textContent,'Page 2 of 3');
});

test('reduced motion has identical page endpoints with no animation; ordinary motion is bounded',()=>{
  const reduced=fixture({reduced:true});reduced.turn(1);
  assert.equal(reduced.animations.length,0);assert.equal(reduced.get('page-count').textContent,'Page 2 of 3');
  const regular=fixture();regular.turn(1);regular.turn(1);
  assert.equal(regular.animations.length,4);
  assert(regular.animations.slice(0,2).every(item=>item.cancelled));
});

test('page keys work from the turn controls and leave text inputs alone',()=>{
  const h=fixture();let clicked=0;
  h.get('next-button').listeners.click=()=>{clicked++;};
  const event={key:'ArrowRight',preventDefault(){this.defaultPrevented=true;},target:{closest:selector=>selector==='.page-turns'?{}:selector==='button,a,summary'?{}:null}};
  h.listeners.keydown(event);assert.equal(clicked,1);assert.equal(event.defaultPrevented,true);
  h.listeners.keydown({key:'ArrowRight',target:{closest:()=>({})}});
  assert.equal(clicked,1);
});


test('a hidden language does not create blank pages or affect the visible page count',()=>{
  const h=fixture();
  h.get('zh-column').hidden=true;
  h.get('zh-content').pages=80;
  h.reader.restore({});
  assert.equal(h.get('page-count').textContent,'Page 1 of 3');
  h.turn(1);h.turn(1);
  assert.equal(h.get('page-count').textContent,'Page 3 of 3');
  h.turn(1);assert.equal(h.counts().advances,1);
});
