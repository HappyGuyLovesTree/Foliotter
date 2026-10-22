/* Original-art encounters own a separate, atomic state; no reader storage access. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RedbookEncounterCore=api;})(typeof window==='object'?window:this,()=>{
  'use strict';
  const KEY='redbook.encounter.v1',copy=v=>JSON.parse(JSON.stringify(v));
  function shuffle(ids,random=Math.random,last=null){const q=ids.slice();for(let i=q.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[q[i],q[j]]=[q[j],q[i]];}if(q.length>1&&q[0]===last){const j=1+Math.floor(random()*(q.length-1));[q[0],q[j]]=[q[j],q[0]];}return q;}
  function create({items,poolHash,bookVersion,manifestVersion,storage,readonly=false,random=Math.random,now=()=>new Date().toISOString(),eventId=()=>crypto.randomUUID()}){
    const map=new Map(items.map(x=>[x.imageId,x])),ids=[...map.keys()];let busy=false,pending=null,blocked=readonly,conflict=false,notice=readonly?'只读模式：本次相遇仅在会话中，刷新可能丢失。':'',rawSeen=null;
    const fresh=()=>({schemaVersion:1,bookVersion,manifestVersion,poolHash,revision:0,queue:[],cursor:0,lastDrawId:null,current:null,history:[],uiMode:'closed',returnContext:null});let state=fresh();
    function validEvent(e){return e&&typeof e.eventId==='string'&&e.eventId.length<180&&typeof e.imageId==='string'&&e.kind==='artwork'&&typeof e.at==='string'&&Number.isFinite(Date.parse(e.at))&&typeof e.manifestVersion==='string';}
    function validAnchor(a){return a===null||a===undefined||(typeof a==='object'&&typeof a.unitId==='string'&&['zh','en'].includes(a.language)&&(!a.blockId||typeof a.blockId==='string')&&(a.offsetRatio===undefined||Number.isFinite(a.offsetRatio)&&a.offsetRatio>=0&&a.offsetRatio<=1));}
    function validate(s){
      if(!s||s.schemaVersion!==1)throw Error('原画记录版本不支持');if(s.bookVersion!==bookVersion)throw Error('原画记录底本不同');
      if(typeof s.poolHash!=='string'||typeof s.manifestVersion!=='string'||!Number.isSafeInteger(s.revision)||s.revision<0)throw Error('原画记录身份无效');
      if(!Array.isArray(s.queue)||s.queue.some(x=>typeof x!=='string')||new Set(s.queue).size!==s.queue.length||!Number.isInteger(s.cursor)||s.cursor<0||s.cursor>s.queue.length)throw Error('原画队列损坏');
      if(s.poolHash===poolHash&&s.queue.length&&(s.queue.length!==ids.length||s.queue.some(x=>!map.has(x))))throw Error('原画队列成员不符');
      if(!Array.isArray(s.history)||s.history.length>100||s.history.some(e=>!validEvent(e))||new Set(s.history.map(e=>e.eventId)).size!==s.history.length||s.current!==null&&!validEvent(s.current))throw Error('原画历史损坏');
      if(!['closed','artwork','reading'].includes(s.uiMode)||s.lastDrawId!==null&&typeof s.lastDrawId!=='string')throw Error('原画显示状态损坏');
      if(s.returnContext!==null&&(!s.returnContext||!validAnchor(s.returnContext.entryAnchor)||!validAnchor(s.returnContext.backgroundAnchor)))throw Error('原画返回位置损坏');
      return s;
    }
    function load(){
      try{const raw=storage.getItem(KEY);rawSeen=raw;if(raw!==null){state=validate(JSON.parse(raw));if(state.poolHash!==poolHash){state={...state,poolHash,queue:[],cursor:0,manifestVersion};notice='可用画页已更新，开始新一轮。';}}}
      catch(e){blocked=true;notice=`${e.message}。本次相遇未保存，刷新可能丢失；旧记录已保留。`;state=fresh();}
    }
    function checkConflict(){if(blocked)return true;try{if(storage.getItem(KEY)!==rawSeen){conflict=true;notice='另一页已更新原画记录。请重新读取后继续。';return false;}}catch(e){blocked=true;notice='本次相遇未保存，刷新可能丢失。';}return true;}
    function commit(next){if(!checkConflict())return false;next.revision=state.revision+1;next.manifestVersion=manifestVersion;state=next;if(!blocked){try{const raw=JSON.stringify(state);storage.setItem(KEY,raw);rawSeen=raw;}catch(e){blocked=true;notice='本次相遇未保存，刷新可能丢失。';}}return true;}
    load();
    return {
      get state(){return copy(state);},get busy(){return busy;},get notice(){return notice;},get conflict(){return conflict;},get pendingId(){return pending?.id||null;},get saved(){return !blocked;},
      async draw(loadImage){
        if(busy||conflict||!ids.length||!checkConflict())return false;busy=true;
        try{
          if(!pending){const queue=state.cursor>=state.queue.length?shuffle(ids,random,state.lastDrawId):state.queue.slice();const cursor=state.cursor>=state.queue.length?0:state.cursor;pending={id:queue[cursor],queue,cursor,eventId:eventId()};}
          await loadImage(map.get(pending.id));if(conflict||!checkConflict())return false;
          const item=map.get(pending.id),e={eventId:pending.eventId,imageId:item.imageId,kind:'artwork',at:now(),manifestVersion,marker:item.marker,attribution:item.attribution,target:item.readingTargets[item.defaultTarget||0]};
          const next={...copy(state),queue:pending.queue,cursor:pending.cursor+1,lastDrawId:item.imageId,current:e,history:[...state.history,e].slice(-100),poolHash};
          const ok=commit(next);if(ok)pending=null;return ok;
        }finally{busy=false;}
      },
      replay(event){if(busy||conflict||!validEvent(event))return false;return commit({...copy(state),current:copy(event)});},
      mode(uiMode,returnContext=state.returnContext){if(!['closed','artwork','reading'].includes(uiMode))return false;return commit({...copy(state),uiMode,returnContext:copy(returnContext)});},
      notifyExternal(){if(!blocked){conflict=true;notice='另一页已更新原画记录。请重新读取后继续。';}},
      reload(){if(busy)return false;blocked=readonly;conflict=false;pending=null;notice=readonly?'只读模式：本次相遇仅在会话中，刷新可能丢失。':'';state=fresh();load();return true;}
    };
  }
  return {KEY,shuffle,create};
});
