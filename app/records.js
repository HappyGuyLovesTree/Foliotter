'use strict';
/* Local records only. Reader owns these keys; encounter modules use its adapter. */
(() => {
  const V1 = 'redbook.reader.v1', V2 = 'redbook.reader.v2', BACKUP = 'redbook.reader.v1.backup';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const date = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  function safeParse(raw) {
    try {return JSON.parse(raw, (key,value) => { if (['__proto__','prototype','constructor'].includes(key)) throw Error('文件含不允许的对象键'); return value; });}
    catch(error){if(error instanceof SyntaxError)throw Error('JSON格式损坏，请重新选择备份文件');throw error;}
  }
  function identity(data) {
    return {bookId:data.metadata?.bookId || 'redbook-local',sourceShas:Object.fromEntries((data.metadata?.sources || data.metadata?.sourceFiles || []).map(s => [s.language,s.sha256])),datasetId:data.metadata?.datasetId || data.metadata?.datasetVersion || 'legacy-20'};
  }
  function empty(data) {
    return {schemaVersion:2,...identity(data),current:null,today:{},queue:[],history:[],favorites:[],notes:{},positions:{},visited:{},orphans:[],conflicts:[],updatedAt:new Date().toISOString()};
  }
  function validate(s) {
    if (!object(s) || s.schemaVersion !== 2) throw Error('记录版本不支持');
    for (const key of ['queue','history','favorites','orphans']) if (!Array.isArray(s[key])) throw Error(`记录字段 ${key} 格式错误`);
    for (const key of ['notes','positions','visited','today']) if (!object(s[key])) throw Error(`记录字段 ${key} 格式错误`);
    if (!s.favorites.every(x => typeof x === 'string') || !s.queue.every(x => typeof x === 'string')) throw Error('单元标识格式错误');
    if (!Object.values(s.notes).every(x => typeof x === 'string')) throw Error('笔记必须是文字');
    if (!s.history.every(x => object(x) && typeof x.id === 'string' && typeof x.at === 'string' && (!x.reason || typeof x.reason === 'string'))) throw Error('历史记录格式错误');
    if (s.current !== null && (!object(s.current) || typeof s.current.unitId !== 'string' || !['zh','en'].includes(s.current.language))) throw Error('当前位置格式错误');
    if (Object.keys(s.today).length && (typeof s.today.id !== 'string' || typeof s.today.date !== 'string')) throw Error('今日记录格式错误');
    for (const p of Object.values(s.positions)) {
      if (!object(p) || !['zh','en'].includes(p.language) || (p.blockId !== undefined && typeof p.blockId !== 'string') || (p.offsetRatio !== undefined && (!Number.isFinite(p.offsetRatio) || p.offsetRatio < 0 || p.offsetRatio > 1)) || (p.legacyScrollY !== undefined && (!Number.isFinite(p.legacyScrollY) || p.legacyScrollY < 0))) throw Error('阅读位置格式错误');
    }
    for (const v of Object.values(s.visited)) if (!object(v) || typeof v.firstAt !== 'string' || typeof v.lastAt !== 'string' || !Number.isFinite(Date.parse(v.firstAt)) || !Number.isFinite(Date.parse(v.lastAt))) throw Error('访问记录格式错误');
    if (s.conflicts !== undefined && (!Array.isArray(s.conflicts) || !s.conflicts.every(c => object(c) && typeof c.id === 'string' && typeof c.local === 'string' && typeof c.incoming === 'string'))) throw Error('冲突记录格式错误');
    return s;
  }
  function migrate(raw,data) {
    const old = safeParse(raw); if (!object(old)) throw Error('旧记录格式错误');
    const s=empty(data);
    for (const key of ['queue','history','favorites']) if (old[key] !== undefined && !Array.isArray(old[key])) throw Error(`旧记录 ${key} 格式错误`);
    for (const key of ['notes','positions','today']) if (old[key] !== undefined && !object(old[key])) throw Error(`旧记录 ${key} 格式错误`);
    if (old.current !== undefined && old.current !== null && typeof old.current !== 'string') throw Error('旧当前位置格式错误');
    s.current=old.current ? {unitId:old.current,language:'zh'} : null;
    for (const key of ['queue','history','favorites','notes','today']) if (old[key] !== undefined) s[key]=clone(old[key]);
    for (const [id,y] of Object.entries(old.positions || {})) { if (!Number.isFinite(y) || y < 0) throw Error('旧位置格式错误'); s.positions[id]={language:'zh',legacyScrollY:y}; }
    for (const h of s.history) if (typeof h.id==='string' && typeof h.at==='string') { const v=s.visited[h.id]; s.visited[h.id]={firstAt:v && v.firstAt<h.at?v.firstAt:h.at,lastAt:v && v.lastAt>h.at?v.lastAt:h.at,source:'legacy-history'}; }
    s.migratedFrom={key:V1,raw,at:new Date().toISOString(),visitedSource:'只从现存历史恢复访问，不推断更早记录'};
    return validate(s);
  }
  function orphanRecords(s,data) {
    const ids=new Set(data.units.map(u=>u.id)); const aliases=data.legacy?.unitAliases || {};
    const result=clone(s.orphans || []); const add=(kind,id,value)=> { if (!ids.has(id) && !ids.has(aliases[id]) && !result.some(o=>o.kind===kind && o.id===id && JSON.stringify(o.value)===JSON.stringify(value))) result.push({kind,id,value:clone(value),bookId:s.bookId,sourceShas:s.sourceShas}); };
    for (const id of s.favorites) add('favorite',id,true);
    for (const id of s.queue) add('queue',id,id);
    for (const [id,value] of Object.entries(s.visited)) add('visited',id,value);
    for (const [id,value] of Object.entries(s.notes)) add('note',id,value);
    for (const [id,value] of Object.entries(s.positions)) add('position',id,value);
    for (const h of s.history) add('history',h.id,h);
    if (s.current) add('current',s.current.unitId,s.current);
    if (s.today.id) add('today',s.today.id,s.today);
    return result;
  }
  function copyFields(s,data) {
    const r=empty(data); for (const key of ['current','today','queue','history','favorites','notes','positions','visited','orphans','conflicts','migratedFrom','queuePool']) if (s[key]!==undefined) r[key]=clone(s[key]);
    r.orphans=orphanRecords(r,data); return validate(r);
  }
  function open(data,{storage,readonly=false,locks=globalThis.navigator?.locks,lockName='redbook.reader.v2.write'}={}) {
    let available=true,blocked=readonly,notice='',raw1=null,raw2=null,rawBackup=null,state=empty(data);
    try {
      raw1=storage.getItem(V1); raw2=storage.getItem(V2); rawBackup=storage.getItem(BACKUP);
      if (raw2 !== null) {
        const parsed=validate(safeParse(raw2)); const id=identity(data);
        if (parsed.bookId!==id.bookId || ['zh','en'].some(l=>parsed.sourceShas?.[l]!==id.sourceShas[l])) throw Error('已保存记录属于不同书籍或底本，原记录已保留');
        state=copyFields(parsed,data);
      } else if (raw1 !== null) {
        state=migrate(raw1,data); state.orphans=orphanRecords(state,data);
      }
    } catch(error) { available=false; blocked=true; notice=`${error.message}。原记录保留，本次修改仅在会话中；请先导出备份。`; }
    if (readonly) notice='只读备份模式：阅读与操作不会改写已保存记录。';
    // A cooperating reader owns the origin-wide writer lock for its store lifetime.
    // Other stores fail closed, even if their localStorage cache has not caught up.
    // Reading and migration above are side-effect free until a guarded commit.
    const baseline={v1:raw1,v2:raw2,backup:rawBackup}, previews=new WeakMap();
    const content=value=>{const snapshot=clone(value);delete snapshot.updatedAt;return JSON.stringify(snapshot);};
    let savedContent=content(state),pending=Promise.resolve(),owner=null,ownerFinished=null,releaseOwner=null;
    function ownWriter() {
      if(!owner)owner=new Promise((resolve,reject)=>{
        const held=new Promise(release=>{releaseOwner=release;});
        try {Promise.resolve(ownerFinished=locks.request(lockName,{mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock){reject(Error('另一阅读页正在保存记录，本页已停止写入；请先导出本页备份，再关闭其他阅读页并刷新'));return;}
          resolve();await held;
        })).catch(reject);}catch(error){reject(error);}
      });
      return owner;
    }
    const recovery='本页修改仍在会话中。请打开“备份与恢复”导出本页备份，再刷新读取最新记录；需要时选择该备份合并恢复并处理笔记冲突。';
    if(!readonly && !blocked && typeof locks?.request!=='function') {
      available=false;blocked=true;notice='当前浏览器不支持安全的多标签保存。请使用支持 Web Locks 的浏览器打开本页。'+recovery;
    }
    function checkBaseline() {
      if(storage.getItem(V2)!==baseline.v2 || storage.getItem(V1)!==baseline.v1 || storage.getItem(BACKUP)!==baseline.backup)
        throw Error('其他标签或窗口已更改记录，本页已停止保存以保护双方内容');
    }
    function commit(next) {
      checkBaseline();validate(next);
      const previous=baseline.v2,encoded=JSON.stringify(next);
      try {
        if(baseline.v2===null && raw1!==null && baseline.backup===null) {
          storage.setItem(BACKUP,raw1);
          if(storage.getItem(BACKUP)!==raw1)throw Error('旧记录备份回读失败');
          baseline.backup=raw1;
        }
        storage.setItem(V2,encoded);
        if(storage.getItem(V2)!==encoded)throw Error('保存回读不一致');
        baseline.v2=encoded;savedContent=content(next);available=true;
      } catch(error) {
        // Never roll a different writer's bytes back. Only undo our own exact value.
        try {if(storage.getItem(V2)===encoded){if(previous===null)storage.removeItem(V2);else storage.setItem(V2,previous);}}catch(_){}
        throw error;
      }
    }
    function enqueue(action) {
      const task=pending.then(async()=>{
        if(blocked)throw Error(notice || '当前为只读状态；原记录未改写');
        try {await ownWriter();if(blocked)throw Error(notice || '本页记录已停止写入');return action();}
        catch(error){if(error.retryPreview)throw error;available=false;blocked=true;notice=error.message+'。'+recovery;throw Error(notice);}
      });
      pending=task.catch(()=>{});return task;
    }
    return {
      async close(){blocked=true;releaseOwner?.();await ownerFinished;},
      get state(){return state;},get dirty(){return !readonly && content(state)!==savedContent;},get available(){return available && !blocked;},get notice(){return notice;},
      async persist() {
        // Capture the requested value now; later input stays in the live state.
        const sourceState=state,next=clone(state);next.updatedAt=new Date().toISOString();
        try {await enqueue(()=>{if(state===sourceState)commit(next);});return true;}catch(_){return false;}
      },
      export() {return {format:'redbook-records',schemaVersion:2,exportedAt:new Date().toISOString(),...identity(data),state:clone(state),preservedStorage:{v1Raw:raw1,v2Raw:raw2,v1BackupRaw:rawBackup}};},
      preview(raw) {
        if (typeof raw!=='string' || new TextEncoder().encode(raw).length>10*1024*1024) throw Error('备份文件超过10MiB');
        const input=safeParse(raw); const id=identity(data);
        if (!object(input) || input.format!=='redbook-records' || input.schemaVersion!==2) throw Error('不是支持的红书记录备份（版本2）');
        if (input.bookId!==id.bookId) throw Error('备份属于另一部书');
        if (['zh','en'].some(l=>input.sourceShas?.[l]!==id.sourceShas[l])) throw Error('备份底本不同，不能直接恢复');
        validate(input.state);
        if (input.state.bookId!==input.bookId || ['zh','en'].some(l=>input.state.sourceShas?.[l]!==input.sourceShas[l])) throw Error('备份内部书籍身份不一致');
        const incoming=copyFields(input.state,data), known=new Set(data.units.map(u=>u.id)), aliases=data.legacy?.unitAliases||{};
        const resolve=id=>known.has(id)?id:known.has(aliases[id])?aliases[id]:id;
        incoming.favorites=[...new Set(incoming.favorites.map(resolve))]; incoming.queue=incoming.queue.map(resolve);
        incoming.history=incoming.history.map(h=>({...h,id:resolve(h.id)}));
        incoming.conflicts=incoming.conflicts || [];
        for(const field of ['notes','positions','visited']) {
          const mapped={};for(const [originalId,value] of Object.entries(incoming[field])) {
            const id=resolve(originalId);
            if(Object.hasOwn(mapped,id) && JSON.stringify(mapped[id])!==JSON.stringify(value)) {
              if(field==='notes')incoming.conflicts.push({id,local:mapped[id],incoming:value,importedAt:new Date().toISOString()});
              else incoming.orphans.push({kind:'alias-conflict-'+field,id:originalId,value:clone(value),bookId:incoming.bookId,sourceShas:incoming.sourceShas});
            }else mapped[id]=value;
          }incoming[field]=mapped;
        }
        if(incoming.current)incoming.current.unitId=resolve(incoming.current.unitId);if(incoming.today.id)incoming.today.id=resolve(incoming.today.id);
        incoming.orphans=orphanRecords(incoming,data);
        let added=0,duplicate=0,conflicts=0;
        for (const id of incoming.favorites) state.favorites.includes(id)?duplicate++:added++;
        for (const [id,note] of Object.entries(incoming.notes)) { if(!Object.hasOwn(state.notes,id))added++;else if(state.notes[id]===note)duplicate++;else conflicts++; }
        const result={incoming,added,duplicate,conflicts,orphans:incoming.orphans.length,differentDataset:input.datasetId!==id.datasetId};
        previews.set(result,{baseline:{...baseline},state:JSON.stringify(state),incoming:JSON.stringify(incoming)});return result;
      },
      async apply(preview,{replace=false,restorePosition=false}={}) {
        const checked=previews.get(preview);
        if(!checked)throw Error('恢复预检无效，请重新选择备份');
        return enqueue(()=>{
        checkBaseline();
        if(JSON.stringify(baseline)!==JSON.stringify(checked.baseline) || JSON.stringify(state)!==checked.state || JSON.stringify(preview.incoming)!==checked.incoming){const error=Error('预检后记录已变化，请重新选择备份并检查');error.retryPreview=true;throw error;}
        const a=preview.incoming; let next;
        if(replace) next=clone(a);
        else {
          next=clone(state);next.favorites=[...new Set([...next.favorites,...a.favorites])];
          const seen=new Set(next.history.map(h=>JSON.stringify([h.id,h.at,h.reason])));
          for(const h of a.history) {const k=JSON.stringify([h.id,h.at,h.reason]);if(!seen.has(k)){next.history.push(clone(h));seen.add(k);}}
          next.history.sort((x,y)=>y.at.localeCompare(x.at)); next.history=next.history.slice(0,100);
          next.conflicts=next.conflicts || [];
          for(const [id,note] of Object.entries(a.notes)) {
            if(!Object.hasOwn(next.notes,id)) next.notes[id]=note;
            else if(next.notes[id]!==note && !next.conflicts.some(c=>c.id===id&&c.incoming===note)) next.conflicts.push({id,local:next.notes[id],incoming:note,importedAt:new Date().toISOString()});
          }
          for(const c of a.conflicts||[]) if(!next.conflicts.some(x=>x.id===c.id&&x.incoming===c.incoming))next.conflicts.push(clone(c));
          for(const [id,v] of Object.entries(a.visited)){const old=next.visited[id];next.visited[id]=old?{firstAt:old.firstAt<v.firstAt?old.firstAt:v.firstAt,lastAt:old.lastAt>v.lastAt?old.lastAt:v.lastAt}:clone(v);}
          for(const [id,p] of Object.entries(a.positions))if(!next.positions[id])next.positions[id]=clone(p);
          next.orphans=[...next.orphans,...a.orphans.filter(o=>!next.orphans.some(x=>JSON.stringify(x)===JSON.stringify(o)))];
          if(restorePosition){next.current=clone(a.current);next.today=clone(a.today);next.positions=clone(a.positions);}
        }
        next={...next,...identity(data),updatedAt:new Date().toISOString()}; validate(next);
        commit(next);state=next;previews.delete(preview);return state;
        });
      }
    };
  }
  window.RedbookRecords={open,identity,empty,validate,migrate,safeParse,date,keys:{V1,V2,BACKUP}};
})();
