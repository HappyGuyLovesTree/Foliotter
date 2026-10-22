/* Local isolated browser fixture. This script is loaded only by encounter-fixture.html. */
'use strict';
if(new URLSearchParams(location.search).get('records')!=='session')throw Error('Fixture requires isolated records=session');
(()=>{
 const kind=new URLSearchParams(location.search).get('case')||'normal',KEY='redbook.encounter.v1',get=Storage.prototype.getItem,set=Storage.prototype.setItem,original=window.fetch.bind(window);
 window.fetch=async(input,init)=>{const res=await original(input,init);if(String(input)!=='/data/artworks.json')return res;const m=await res.json();if(kind==='zero')m.items=[];if(['one','missing','delayed','section'].includes(kind))m.items=m.items.filter(x=>x.seed).slice(0,1);if(kind==='section'){const t=m.items[0].readingTargets[0];m.items[0].readingTargets=[{relation:'section',sectionId:t.sectionId,unitId:null,anchor:{sectionId:t.sectionId,language:'zh'}}];m.items[0].defaultTarget=0;}if(kind==='manifest')m.schemaVersion=99;if(kind==='missing')for(const x of m.items)x.asset.url='/data/fullbook-assets/zh/missing-qa.jpeg';return new Response(JSON.stringify(m),{status:200,headers:{'Content-Type':'application/json'}});};
 if(kind==='broken')set.call(sessionStorage,KEY,'{');if(kind==='schema')set.call(sessionStorage,KEY,JSON.stringify({schemaVersion:9}));if(kind==='book')set.call(sessionStorage,KEY,JSON.stringify({schemaVersion:1,bookVersion:'different-book'}));
 if(kind==='getfail')Storage.prototype.getItem=function(k){if(k===KEY)throw Error('QA storage read refused');return get.call(this,k);};
 if(kind==='setfail')Storage.prototype.setItem=function(k,v){if(k===KEY)throw Error('QA storage quota refused');return set.call(this,k,v);};
 if(kind==='delayed'){const decode=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=async function(){await new Promise(r=>setTimeout(r,300));return decode.call(this);};}
})();
