'use strict';

// Read-only chapter windows. Correspondences come only from the reviewed index.
(function (root) {
  function create({getUnit, getSection, getGroup} = {}) {
    if (![getUnit, getSection, getGroup].every(value => typeof value === 'function')) {
      throw new TypeError('ReadingContext requires getUnit, getSection and getGroup');
    }
    const languages = ['zh', 'en'];
    const hasLanguage = (unit, language) => Boolean(unit &&
      (unit[language]?.length || unit.structure?.language === language));
    const count = (value, maximum) => typeof value === 'number' && Number.isFinite(value)
      ? Math.min(maximum, Math.max(0, Math.floor(value))) : 0;

    function windowFor({unitId, language, before = 0, after = 0} = {}) {
      if (!languages.includes(language)) return null;
      const unit = getUnit(unitId);
      if (!unit || !hasLanguage(unit, language)) return null;
      const section = getSection(unit.sectionId);
      if (!section || section.id !== unit.sectionId) return null;
      const orders = {}, positions = {};
      for (const lang of languages) {
        const order = section.readingOrder?.[lang];
        orders[lang] = Array.isArray(order) ? order : [];
        positions[lang] = new Map(orders[lang].map((id, index) => [id, index]));
      }
      const order = orders[language], position = positions[language];
      if (!position.has(unit.id) || position.size !== order.length) return null;
      const validUnit = (value, lang) => hasLanguage(value, lang) &&
        value.sectionId === section.id && positions[lang].has(value.id);
      const single = value => ({
        id:`single-${language}-${value.id}`, zh:language === 'zh' ? [value] : [],
        en:language === 'en' ? [value] : [], aligned:false, legacy:false
      });

      function rowFor(value) {
        if (!validUnit(value, language)) return null;
        const group = getGroup(value.id);
        if (group && typeof group.id === 'string' && group.id &&
            (!group.sectionId || group.sectionId === section.id)) {
          const sides = {}, allIds = new Set();
          let valid = true;
          for (const lang of languages) {
            const ids = group[lang];
            if (!Array.isArray(ids) || !ids.length || positions[lang].size !== orders[lang].length) {
              valid = false; break;
            }
            sides[lang] = [];
            let previous = -1;
            for (const id of ids) {
              const source = getUnit(id), index = positions[lang].get(id);
              // Native dual-language units retain their original reviewed pair.
              if (allIds.has(id) || !validUnit(source, lang) ||
                  (source.zh?.length && source.en?.length) ||
                  (previous >= 0 && index !== previous + 1)) {
                valid = false; break;
              }
              allIds.add(id);sides[lang].push(source);previous = index;
            }
            if (!valid) break;
          }
          if (valid && group[language].includes(value.id)) {
            return {id:group.id, ...sides, aligned:true, legacy:false,
              ...(group.review ? {review:group.review} : {})};
          }
        }
        const nativeVerified = (value.alignmentV2 || value.alignment)?.status === 'verified';
        if (nativeVerified && value.zh?.length && value.en?.length &&
            languages.every(lang => validUnit(value, lang) &&
              positions[lang].size === orders[lang].length)) {
          return {id:`legacy-${value.id}`, zh:[value], en:[value], aligned:true, legacy:true};
        }
        return single(value);
      }

      const origin = rowFor(unit);
      if (!origin) return null;
      const first = position.get(origin[language][0].id);
      const last = position.get(origin[language].at(-1).id);
      const seenRows = new Set([origin.id]);
      const seenUnits = new Set(languages.flatMap(lang => origin[lang].map(value => value.id)));

      function collect(start, direction, requested) {
        const rows = [];
        let cursor = start;
        while (cursor >= 0 && cursor < order.length && rows.length < requested) {
          const value = getUnit(order[cursor]);
          let row = rowFor(value);
          if (!row) { cursor += direction; continue; }
          const firstIndex = position.get(row[language][0].id);
          const lastIndex = position.get(row[language].at(-1).id);
          const ids = languages.flatMap(lang => row[lang].map(source => source.id));
          // A malformed provider must not duplicate a source or consume an
          // already displayed group. Fall back to the independent source unit.
          if (seenRows.has(row.id) || ids.some(id => seenUnits.has(id))) {
            row = seenUnits.has(value.id) ? null : single(value);
          }
          if (row) {
            rows.push(row);seenRows.add(row.id);
            for (const lang of languages) for (const source of row[lang]) seenUnits.add(source.id);
          }
          // Even with malformed correspondence data, traversal always advances.
          cursor = row?.aligned
            ? (direction < 0 ? firstIndex - 1 : lastIndex + 1)
            : cursor + direction;
        }
        if (direction < 0) rows.reverse();
        return {rows, hasMore:cursor >= 0 && cursor < order.length};
      }

      const preceding = collect(first - 1, -1, count(before, order.length));
      const following = collect(last + 1, 1, count(after, order.length));
      return {
        origin, before:preceding.rows, after:following.rows,
        hasBefore:preceding.hasMore, hasAfter:following.hasMore,
        sectionId:section.id, language
      };
    }
    return Object.freeze({window:windowFor});
  }
  const api = Object.freeze({create});
  root.ReadingContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
