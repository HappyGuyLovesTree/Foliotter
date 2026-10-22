'use strict';

// Reading preferences are separate from interface locale and reading records.
// A second column is made only from an existing, verified source relationship.
window.ReadingLanguage = (() => {
  const languages=['en','zh'];
  const has=(unit,lang)=>Boolean(unit && (unit[lang]?.length || unit.structure?.language===lang));
  function create(data,{getGroup=()=>null}={}) {
    const units=data.units || [],byId=new Map(units.map(unit=>[unit.id,unit]));
    const available=languages.filter(lang=>units.some(unit=>has(unit,lang)));
    const primary=wanted=>available.includes(wanted)?wanted:available.includes('en')?'en':available[0] || 'en';
    function group(unit) {
      if(!unit)return null;
      const found=getGroup(unit.id);
      if(found){
        const value={...found,legacy:false};
        for(const lang of languages)value[lang]=(found[lang] || []).map(item=>typeof item==='string'?byId.get(item):item).filter(item=>has(item,lang));
        return languages.every(lang=>value[lang].length)?value:null;
      }
      if(((unit.alignmentV2 || unit.alignment)?.status==='verified' || data.schemaVersion!==2) && languages.every(lang=>has(unit,lang)))return {id:`legacy-${unit.id}`,sectionId:unit.sectionId,en:[unit],zh:[unit],legacy:true};
      return null;
    }
    function resolve(unit,wanted,{fallback=false}={}) {
      const lang=primary(wanted);
      if(has(unit,lang))return unit;
      const paired=group(unit)?.[lang]?.[0];
      if(paired)return paired;
      if(!fallback)return null;
      return units.find(item=>item.sectionId===unit?.sectionId && has(item,lang)) || units.find(item=>has(item,lang));
    }
    function randomPool(wanted) {
      const lang=primary(wanted),ids=new Set();
      for(const unit of units){
        const eligible=data.metadata?.imported?unit.kind==='prose':data.schemaVersion===2?unit.randomEligible===true:true;
        if(!eligible)continue;
        const candidates=has(unit,lang)?[unit]:group(unit)?.[lang] || [];
        for(const item of candidates)if(has(item,lang) && (item[lang] || []).some(paragraph=>paragraph.text?.trim()))ids.add(item.id);
      }
      return [...ids];
    }
    function columns(unit,wanted,secondary='off') {
      const lang=has(unit,wanted)?wanted:languages.find(value=>has(unit,value)) || primary(wanted);
      const paired=group(unit),other=lang==='en'?'zh':'en';
      return {language:lang,comparison:secondary===other && paired?paired:null,languages:secondary===other && paired?[lang,other]:[lang]};
    }
    return {available,primary,has,group,resolve,randomPool,columns};
  }
  return {create,has};
})();
