'use strict';
(async()=>{
const q=new URLSearchParams(location.search),party=q.get('party')||'A',run=q.get('run')||'20261019',prefix='F001.04.'+run+'.',channel=new BroadcastChannel(prefix),report=document.getElementById('report');
let store,requestedAt,acquiredAt,heldAt,releasedAt,started=false;
const storage={getItem:k=>localStorage.getItem(prefix+k),setItem:(k,v)=>localStorage.setItem(prefix+k,v),removeItem:k=>localStorage.removeItem(prefix+k)};
const locks={request:(name,options,fn)=>{requestedAt=Date.now();return navigator.locks.request(name,options,lock=>{acquiredAt=Date.now();return fn(lock);});}};
const data=await(await fetch('/data/reading.json')).json();
function show(value){report.textContent=JSON.stringify({party,run,...value},null,2);}
async function save(){if(started)return;started=true;const id=party==='A'?'lp-001':'lp-002';store.state.notes[id]='synthetic '+party;store.state.favorites.push(id);const ok=await store.persist();show({ok,requestedAt,acquiredAt,heldAt,releasedAt,notice:store.notice,disk:JSON.parse(storage.getItem('redbook.reader.v2')),sessionExport:store.export().state});}
channel.onmessage=e=>{if(e.data.type==='go'){heldAt=e.data.heldAt;save();}};
document.getElementById('prepare').onclick=()=>{store=window.RedbookRecords.open(data,{storage,locks,lockName:'redbook.reader.v2.F001.'+run});show({prepared:true,nativeWebLocks:typeof navigator.locks?.request==='function',baseline:storage.getItem('redbook.reader.v2')});};
document.getElementById('start').onclick=()=>{heldAt=Date.now();channel.postMessage({type:'go',heldAt});save();};
})();
