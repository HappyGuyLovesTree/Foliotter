'use strict';

// Browser columns paginate the original live DOM. No text slicing, cloned note
// controls or inferred sentence pairs enter the source/alignment/record models.
window.ReadingPages = (() => {
  function create({onTurn=()=>{}}={}) {
    const $=id=>document.getElementById(id);
    const body=document.body,stage=$('reading-stage'),spread=document.querySelector('.bilingual');
    if(!stage || !spread)return null;
    const panes=['zh','en'].map(language=>{
      const content=$(`${language}-content`),column=content.closest('.language-column');
      const viewport=document.createElement('div');viewport.className='page-viewport';
      content.before(viewport);viewport.append(content);
      const ended=document.createElement('p');ended.className='page-ended';ended.hidden=true;
      ended.textContent=`本组${language==='zh'?'中文':'英文'}已读完`;viewport.append(ended);
      return {language,content,column,viewport,ended,count:1,width:0,stride:0};
    });
    let group=null,page=0,total=1,context=false,frame=0,resume=null,dimensions=null;
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const animations=new Set();
    function cancelMotion(){for(const animation of animations)animation.cancel();animations.clear();}
    function animatePage(){
      cancelMotion();if(media.matches)return;
      for(const pane of panes){
        const animation=pane.viewport.animate?.([{opacity:.55,clipPath:'inset(0 0 1% 0)'},{opacity:1,clipPath:'inset(0 0 0 0)'}],{duration:180,easing:'cubic-bezier(.16,1,.3,1)'});
        if(animation){animations.add(animation);animation.finished.then(()=>animations.delete(animation),()=>animations.delete(animation));}
      }
    }
    function updateControls(){
      const previous=$('previous-button'),next=$('next-button');
      const hasPreviousPage=!context && page>0,hasNextPage=!context && page<total-1;
      const previousText=hasPreviousPage?'上一页':'上一段',nextText=hasNextPage?'下一页':'下一段';
      previous.disabled=!hasPreviousPage && !group?.canPrevious;next.disabled=!hasNextPage && !group?.canNext;
      previous.setAttribute('aria-label',previousText);next.setAttribute('aria-label',nextText);
      $('previous-label').textContent=previousText;$('next-label').textContent=nextText;
      $('page-count').textContent=total===1?'完整一组':`本组 ${page+1} / ${total} 页`;
      $('page-explanation').textContent=total===1?'':group?.aligned?'分页按阅读长度，两栏仍按整组对应':'按当前底本分页';
      spread.dataset.page=String(page+1);spread.dataset.pages=String(total);
    }
    function display({motion=false,notify=false}={}){
      page=Math.max(0,Math.min(total-1,page));
      for(const pane of panes){
        const finished=page>=pane.count;
        pane.ended.textContent=pane.content.querySelector('.parallel-empty')?`本组暂无已确认的${pane.language==='zh'?'中文':'英文'}对照`:`本组${pane.language==='zh'?'中文':'英文'}已读完`;
        pane.ended.hidden=!finished;pane.viewport.classList.toggle('page-is-finished',finished);
        pane.content.setAttribute('aria-hidden',String(finished));
        pane.content.style.transform=`translateX(${-Math.min(page,pane.count-1)*pane.stride}px)`;
        pane.viewport.scrollLeft=0;pane.content.scrollTop=0;
        pane.column.dataset.pages=String(pane.count);
      }
      updateControls();if(motion)animatePage();if(notify)onTurn();
    }
    function blockFragments(block,pane){
      const base=pane.viewport.getBoundingClientRect();
      return [...block.getClientRects()].map(rect=>({rect,index:Math.max(0,Math.round((rect.left-base.left+page*pane.stride)/pane.stride))}));
    }
    function locationFor(pane,unitId){
      const owner=[...pane.content.querySelectorAll('[data-reading-unit]')].find(el=>el.dataset.readingUnit===unitId);
      const blocks=[...(owner || pane.content).querySelectorAll('[data-source-paragraph]')];
      for(const block of blocks){
        const fragments=blockFragments(block,pane),visible=fragments.findIndex(item=>item.index===page);
        if(visible>=0)return {blockId:block.dataset.sourceParagraph,offsetRatio:visible/Math.max(1,fragments.length)};
      }
      const last=blocks.at(-1);return last?{blockId:last.dataset.sourceParagraph,offsetRatio:1}:null;
    }
    function snapshot(){
      if(!group || context || !dimensions)return null;
      return {key:group.key,page,width:dimensions?.width ?? spread.clientWidth,height:dimensions?.height ?? spread.clientHeight,font:dimensions?.font,
        locations:Object.fromEntries(panes.map(pane=>[pane.language,locationFor(pane)]))};
    }
    function locate(value,language){
      const pane=panes.find(item=>item.language===language);
      const block=[...pane.content.querySelectorAll('[data-source-paragraph]')].find(el=>el.dataset.sourceParagraph===value?.blockId);
      if(!block)return null;
      const fragments=blockFragments(block,pane);
      const index=Math.min(fragments.length-1,Math.floor((Number(value.offsetRatio)||0)*fragments.length));
      return fragments[Math.max(0,index)]?.index ?? null;
    }
    function layout(keep=null){
      if(context || !group || $('reader').hidden)return;
      body.style.setProperty('--workspace-tools',`${document.querySelector('.reader-toolbar').getBoundingClientRect().height}px`);
      cancelAnimationFrame(frame);frame=0;
      const before=keep || snapshot();
      for(const pane of panes){
        pane.content.style.transform='none';pane.content.removeAttribute('aria-hidden');
        pane.ended.hidden=true;pane.viewport.classList.remove('page-is-finished');
        pane.width=Math.max(1,Math.floor(pane.viewport.clientWidth));pane.stride=pane.width+32;
        const height=Math.max(64,Math.floor(pane.viewport.clientHeight)-2);
        pane.content.style.setProperty('--page-width',`${pane.width}px`);
        pane.content.style.setProperty('--page-height',`${height}px`);
        pane.content.dataset.paginated='true';
      }
      // A bounded width allocation helps a longer English version use the screen.
      // Font sizes are user-selected, never shrunk to force a paragraph to fit.
      for(const pane of panes)pane.count=Math.max(1,Math.ceil((pane.content.scrollWidth-pane.width-1)/pane.stride)+1);
      total=Math.max(...panes.map(pane=>pane.count));
      const font=panes.map(pane=>getComputedStyle(pane.content).fontSize).join('|');
      display();dimensions={width:spread.clientWidth,height:spread.clientHeight,font};
      if(before?.key===group.key){
        if(before.width===spread.clientWidth && before.height===spread.clientHeight && before.font===font)page=before.page;
        else page=locate(before.locations?.[group.language],group.language) ?? before.page;
      }
      display();
    }
    function refresh(){cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>layout());}
    function setGroup(value){
      const changed=group?.key!==value.key || group?.unitId!==value.unitId || group?.language!==value.language;
      group=value;if(changed){page=0;resume=null;dimensions=null;for(const pane of panes)pane.content.style.transform='none';}
      refresh();
    }
    function restore(value,saved){
      if(context || !group)return false;
      layout(saved?.key===group.key?saved:null);
      if(saved?.key===group.key){
        page=saved.width===spread.clientWidth && saved.height===spread.clientHeight && saved.font===dimensions?.font?saved.page:
          locate(saved.locations?.[group.language],group.language) ?? saved.page;
      }else page=locate(value,group.language) ?? 0;
      display();return true;
    }
    function setContext(expanded){
      if(context===expanded)return;
      if(expanded)resume=snapshot();
      context=expanded;cancelMotion();body.classList.toggle('context-reading',expanded);
      if(expanded){
        for(const pane of panes){pane.content.style.transform='none';delete pane.content.dataset.paginated;pane.content.removeAttribute('aria-hidden');pane.ended.hidden=true;pane.viewport.classList.remove('page-is-finished');}
        updateControls();
      }else layout(resume);
    }
    function turn(direction,advance){
      if(context)return advance();
      if(page+direction<0 || page+direction>=total)return advance();
      page+=direction;display({motion:true,notify:true});
    }
    function setNavigation(open){
      $('book-navigation').hidden=!open;$('navigation-shade').hidden=!open;
      $('navigation-toggle').setAttribute('aria-expanded',String(open));
      if(open)$('navigation-close').focus();else $('navigation-toggle').focus({preventScroll:true});
    }
    $('navigation-toggle').addEventListener('click',()=>setNavigation($('book-navigation').hidden));
    $('navigation-close').addEventListener('click',()=>setNavigation(false));
    $('navigation-shade').addEventListener('click',()=>setNavigation(false));
    $('book-navigation').addEventListener('click',event=>{if(event.target.closest('button')?.id!=='navigation-close' && event.target.closest('button'))setNavigation(false);});
    $('reader-size').addEventListener('change',()=>{
      const before=snapshot(),size=Number($('reader-size').value);
      body.style.setProperty('--reader-zh-size',`${24+size*2}px`);
      body.style.setProperty('--reader-en-size',`${22+size*2}px`);
      layout(before);
    });
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape' && !$('book-navigation').hidden){event.preventDefault();setNavigation(false);return;}
      if(event.key==='Escape' && $('reader-more').open && $('detail-panel').hidden && !document.querySelector('dialog[open]')){event.preventDefault();$('reader-more').open=false;$('reader-more').querySelector('summary').focus();return;}
      if(context || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('input,textarea,select,[contenteditable="true"]') || (event.target.closest('button,a,summary') && !event.target.closest('.page-turns')) || !$('detail-panel').hidden || document.querySelector('dialog[open]'))return;
      if(['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(event.key)){
        event.preventDefault();$(['ArrowRight','PageDown'].includes(event.key)?'next-button':'previous-button').click();
      }
    });
    spread.addEventListener('focusin',event=>{
      if(context || !group)return;
      const pane=panes.find(item=>item.content.contains(event.target));
      if(!pane || !event.target.matches('button,a,input,select'))return;
      const rect=event.target.getBoundingClientRect(),base=pane.viewport.getBoundingClientRect();
      if(pane.viewport.scrollLeft || rect.left<base.left-1 || rect.right>base.right+1){
        page=Math.max(0,Math.floor((rect.left-base.left+pane.viewport.scrollLeft+page*pane.stride+1)/pane.stride));display({notify:true});
      }
    });
    const observer=new ResizeObserver(refresh);observer.observe(spread);
    spread.addEventListener('load',refresh,true);spread.addEventListener('error',refresh,true);
    document.fonts?.ready.then(refresh);
    media.addEventListener?.('change',cancelMotion);
    $('book-navigation').hidden=true;
    return {setGroup,refresh,restore,setContext,snapshot,turn,
      get active(){return !context && Boolean(group);},
      getAnchor:()=>group && !context && dimensions?locationFor(panes.find(pane=>pane.language===group.language),group.unitId):null,
      contextOffset:()=>document.querySelector('.reading-top').getBoundingClientRect().height+document.querySelector('.reader-toolbar').getBoundingClientRect().height};
  }
  return {create};
})();
