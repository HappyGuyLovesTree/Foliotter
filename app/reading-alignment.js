'use strict';

// This file only validates explicit reviewed pairs. It never proposes a pair.
(function (root) {
  function buildIndex(reading, payload, readingSha256) {
    const groups = new Map(), byUnit = new Map(), rejected = [];
    const fail = message => ({groups, byUnit, rejected, error:message, getGroup:() => null});
    if (!payload || payload.schemaVersion !== 1) return fail('对照文件格式不受支持');
    if (payload.datasetId !== reading?.metadata?.datasetId) return fail('对照文件与正文版本不同');
    if (!readingSha256 || payload.readingSha256 !== readingSha256) return fail('对照文件的正文校验不一致');
    if (!Array.isArray(payload.groups)) return fail('对照分组格式不正确');
    const units = new Map((reading.units || []).map(unit => [unit.id, unit]));
    const sections = new Map((reading.sections || []).map(section => [section.id, section]));
    const positions = new Map((reading.sections || []).map(section => [section.id,
      Object.fromEntries(['zh','en'].map(lang => [lang,new Map((section.readingOrder?.[lang] || []).map((id,index)=>[id,index]))]))]));
    const candidates = [], groupIds = new Map(), owners = new Map();
    for (const group of payload.groups) {
      if (group?.status !== 'reviewed') continue;
      let reason = '';
      const section = sections.get(group.sectionId);
      if (typeof group.id !== 'string' || !group.id || section?.chapterMatch?.status !== 'verified') reason = '分组或章节标识无效';
      if (group.review?.method !== 'agent-source-reading' || !group.review?.reviewer || typeof group.review?.evidence !== 'string' || group.review.evidence.length < 8) reason = '缺少核对记录';
      for (const lang of ['zh','en']) {
        const ids = group[lang], order = positions.get(group.sectionId)?.[lang];
        if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) {
          reason = '语言侧为空或重复'; continue;
        }
        let previous = -1;
        for (const id of ids) {
          const unit = units.get(id), index = order?.get(id);
          if (!unit || unit.sectionId !== group.sectionId || !(unit[lang]?.length || unit.structure?.language === lang) || index === undefined) reason = '原文单元、语言或章节不符';
          if (unit?.zh?.length && unit?.en?.length) reason = '原有双语单元不应重新配组';
          if (previous >= 0 && index !== previous + 1) reason = '原文单元没有按连续原序排列';
          previous = index;
        }
      }
      if (reason) { rejected.push({id:group.id, reason}); continue; }
      candidates.push(group);
      groupIds.set(group.id, (groupIds.get(group.id) || 0) + 1);
      for (const id of new Set([...group.zh, ...group.en])) {
        if (!owners.has(id)) owners.set(id, []);
        owners.get(id).push(group.id);
      }
    }
    const crossing = new Set();
    for (const section of sections.values()) {
      const position=positions.get(section.id);
      const rows=candidates.filter(group=>group.sectionId===section.id)
        .sort((a,b)=>position.zh.get(a.zh[0])-position.zh.get(b.zh[0]));
      for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
        if(position.en.get(rows[i].en.at(-1))>=position.en.get(rows[j].en[0])){
          crossing.add(rows[i]);crossing.add(rows[j]);
        }
      }
    }
    // Reject every conflicting group, rather than silently choosing the first.
    for (const group of candidates) {
      if (groupIds.get(group.id) !== 1 || [...group.zh,...group.en].some(id => owners.get(id).length !== 1)) {
        rejected.push({id:group.id, reason:'分组标识或原文单元被重复使用'}); continue;
      }
      if(crossing.has(group)){rejected.push({id:group.id, reason:'两语分组先后顺序交叉'});continue;}
      groups.set(group.id, group);
      for (const id of [...group.zh,...group.en]) byUnit.set(id, group);
    }
    return {groups, byUnit, rejected, error:null, getGroup:id => byUnit.get(id) || null};
  }
  const api = Object.freeze({buildIndex});
  root.ReadingAlignment = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
