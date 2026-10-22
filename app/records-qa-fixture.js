'use strict';
// F001.04 dedicated UI fixture. Production localStorage keys are read-only.
(()=>{
 const url=new URL(location.href);if(url.searchParams.get('records')!=='session'){url.searchParams.set('records','session');history.replaceState(null,'',url);}
 const K=['redbook.reader.v1','redbook.reader.v2','redbook.reader.v1.backup','redbook.encounter.v1'];
 const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
 let quota=false;
 Storage.prototype.setItem=function(k,v){if(this===sessionStorage&&k==='redbook.reader.v2'&&quota)throw Error('F001.04 synthetic quota');return set.call(this,k,v);};
 const hash=async raw=>raw===null?null:{bytes:new TextEncoder().encode(raw).length,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(v=>v.toString(16).padStart(2,'0')).join('')};
 const fingerprint=async()=>Object.fromEntries(await Promise.all(K.map(async k=>[k,await hash(get.call(localStorage,k))])));
 window.addEventListener('DOMContentLoaded',async()=>{
 const bar=document.createElement('aside');bar.style='position:relative;z-index:999;background:#ffe6a7;color:#151515;padding:12px;font:14px sans-serif';bar.id='f001-controls';
 const report=document.createElement('pre');report.id='f001-report';report.style='white-space:pre-wrap;max-height:200px;overflow:auto';
 const before=await fingerprint();let checks=[];
 function show(){report.textContent=JSON.stringify({formalBefore:before,checks},null,2);}
 function button(text,fn){const b=document.createElement('button');b.textContent=text;b.onclick=async()=>{try{await fn();}catch(e){checks.push({error:e.message});show();}};bar.append(b);}
 button('注入外部写入',async()=>{const s=JSON.parse(get.call(sessionStorage,'redbook.reader.v2'));s.notes['lp-002']='F001 external preserved';s.favorites.push('lp-002');set.call(sessionStorage,'redbook.reader.v2',JSON.stringify(s));checks.push({externalWrite:'synthetic direct out-of-band update'});show();});
 button('启用配额失败',async()=>{quota=true;checks.push({quota:true});show();});
 button('核验正式四键与会话',async()=>{const after=await fingerprint(),record=JSON.parse(get.call(sessionStorage,'redbook.reader.v2')||'null');checks.push({formalAfter:after,formalUnchanged:JSON.stringify(before)===JSON.stringify(after),sessionNoteIds:Object.keys(record?.notes||{}),sessionFavorites:record?.favorites||[],textarea:document.getElementById('personal-note')?.value,saveState:document.querySelector('.save-state')?.textContent,notice:document.getElementById('storage-notice')?.textContent,toast:document.getElementById('toast')?.textContent});show();});
 bar.append(report);document.body.prepend(bar);show();
 });
})();
