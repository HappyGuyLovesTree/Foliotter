'use strict';
(() => {
  const key='foliotter.ui.locale',listeners=new Set(),bound=new WeakSet();
  let locale='en';
  try{const saved=localStorage.getItem(key);if(saved==='en'||saved==='zh')locale=saved;}catch(_){}
  const text=(en,zh)=>locale==='zh'?zh:en;
  function apply(root=document){
    if(root===document)document.documentElement.lang=locale==='zh'?'zh-CN':'en';
    const nodes=[...(root.matches?.('[data-ui-en][data-ui-zh]')?[root]:[]),...root.querySelectorAll('[data-ui-en][data-ui-zh]')];
    for(const node of nodes)node.textContent=node.getAttribute(locale==='zh'?'data-ui-zh':'data-ui-en');
    for(const attribute of ['aria-label','title','placeholder']){
      const selector=`[data-ui-${attribute}-en][data-ui-${attribute}-zh]`;
      const targets=[...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)];
      for(const node of targets)node.setAttribute(attribute,node.getAttribute(`data-ui-${attribute}-${locale}`));
    }
    for(const select of [...(root.matches?.('[data-ui-locale]')?[root]:[]),...root.querySelectorAll('[data-ui-locale]')]){
      select.value=locale;
      if(!bound.has(select)){bound.add(select);select.addEventListener('change',()=>setLocale(select.value));}
    }
  }
  function change(value,persist){
    if(value!=='en'&&value!=='zh')throw new RangeError('Unsupported interface language');
    const changed=value!==locale;locale=value;
    if(persist)try{localStorage.setItem(key,value);}catch(_){}
    apply();
    if(changed){for(const listener of [...listeners])listener(locale);window.dispatchEvent(new CustomEvent('foliotter:locale-change',{detail:{locale}}));}
    return locale;
  }
  function setLocale(value){return change(value,true);}
  window.FoliotterI18n=Object.freeze({text,getLocale:()=>locale,setLocale,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},apply});
  window.addEventListener('storage',event=>{if(event.key===key)change(event.newValue==='zh'?'zh':'en',false);});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>apply(),{once:true});else apply();
})();
