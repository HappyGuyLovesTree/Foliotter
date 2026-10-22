/* THESIS: Names lead to distinct sources, and one reading origin survives the lookup.
   OWN-WORLD: Warm paper, vermilion actions, ink, open lists and source-language labels.
   STORY: Choose a node or name, inspect the note, deliberately navigate, return to A.
   FIRST VIEWPORT: Chapter title, compact search, then four named source categories.
   FORM: A precise extension of the existing reading panel; no new visual identity.
   FINISH: A-stage isolated review; integration and independent acceptance remain gated. */
'use strict';
(() => {
  const T=(en,zh)=>globalThis.FoliotterI18n?.text(en,zh) ?? (typeof window!=='undefined'?window.FoliotterI18n?.text(en,zh):undefined) ?? zh;
  const categories = () => [
    ['body', T("In the body text","正文中出现")], ['note', T("Mentioned in notes","书注中提及")],
    ['caption', T("Captions and image descriptions","图题 / 图页说明")], ['background', T("Background from other chapters","其他章节来源背景")]
  ];
  const kinds = () => ({person:T("Person","人物"), concept:T("Concept","概念"), work:T("Work","作品"), role:T("Role","角色")});
  const languageName = value => ({zh:T("Chinese","中文"), en:'English', mul:T("Mixed languages","混合语言")})[value] || T("Language unverified","语言待核对");
  const languageTag = value => ({zh:'zh-CN', en:'en', mul:'mul'})[value] || '';
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, action, key, className='dict-action') => {
    const element = node('button', className, text); element.type = 'button';
    if (key) element.dataset.dictKey = key;
    element.addEventListener('click', action); return element;
  };
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  const clone = value => JSON.parse(JSON.stringify(value));

  function create(options) {
    const {reading, readingBytes, reader} = options;
    if (!reading || !reader || reader.version !== 1) throw Error(T("The dictionary requires reader adapter v1","词典需要 reader adapter v1"));
    const sections = new Map(reading.sections.map(section => [section.id, section]));
    const units = new Map(reading.units.map(unit => [unit.id, unit]));
    const fetcher = options.fetch || ((...args) => fetch(...args));
    const sourceUrls = Object.assign({
      aids:'/data/reading-aids.json', artworks:'/data/artworks.json', dictionary:'/data/reading-dictionary.json'
    }, options.sourceUrls);
    let result = null, artworks = null, validBindings = [], status = 'idle', loadError = '', serial = 0;
    let session = null, preview = null, root = null, returning = false, disposed = false;
    let visibility = false;
    const sectionTitle = (id, language='zh') => {
      const title = sections.get(id)?.title;
      return title?.[language] || title?.zh || title?.en || T("Book section","本书节点");
    };
    const notify = () => options.onSessionChange?.(getSessionState());
    const currentDataset = () => reader.datasetId === reading.metadata?.datasetId;
    const recordById = id => result?.recordsById.get(id);
    const routeById = (record, id) => record?.sourceRoutes.find(route => route.routeId === id);
    const artworkById = id => artworks?.items?.find(item => item.imageId === id);
    const currentPage = () => session?.trail.at(-1);
    const freshUI = (sectionId, language) => ({
      sectionId:sectionId || null, slotLanguage:language === 'en' ? 'en' : 'zh',
      nameLanguage:'all', query:'', limit:40,
      expanded:{body:true, note:true, caption:true, background:false},
      batches:{body:30, note:30, caption:30, background:30}, scrollTop:0, focusKey:null
    });
    const message = text => {
      if (session) session.notice = text;
      if (visibility) render();
      options.onNotice?.(text);
    };
    function saveUI() {
      if (!session || !root) return;
      const page = currentPage();
      if (page) {
        page.scrollTop = root.scrollTop;
        page.focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.dictKey || null : null;
        if (page.type === 'lookup') session.ui.scrollTop = page.scrollTop;
      }
    }
    function releasePreview() {
      const value = preview; preview = null;
      value?.release?.(); return value;
    }
    function pausePreview() {
      if (!preview) preview = {
        viewport:reader.captureViewport(), focus:reader.captureFocus(),
        release:reader.pausePositionWrites()
      };
    }
    function ensureSession() {
      if (!currentDataset()) { message(T("The source edition changed. Choose a location from the contents.","底本身份已变化，请从目录重新选择。")); return false; }
      if (!session) {
        const originAnchor = reader.getAnchor();
        if (!originAnchor || !reader.hasTarget(originAnchor)) { message(T("This text location is unavailable. Choose one from the contents.","当前原文位置不可用，请从目录重新选择。")); return false; }
        session = {
          datasetId:reader.datasetId, originAnchor:{...originAnchor},
          viewport:reader.captureViewport(), focus:reader.captureFocus(),
          ui:freshUI(null, originAnchor.language), trail:[], phase:'lookup',
          navigated:false, notice:''
        };
      }
      return true;
    }
    function reveal() {
      pausePreview(); visibility = true; options.onOpen?.();
      render(); notify();
    }
    function open({sectionId=null, language, recordId=null, resetLookup=false}={}) {
      if (disposed || !ensureSession()) return false;
      saveUI();
      if (recordId) {
        if (!recordById(recordId)) return false;
        if (!session.trail.length) session.trail = [{type:'lookup'}];
        if (currentPage()?.type !== 'entry' || currentPage()?.recordId !== recordId) session.trail.push({type:'entry', recordId, scrollTop:0, focusKey:'back'});
      } else if (sectionId !== session.ui.sectionId || !session.trail.length) {
        if (sectionId && !sections.has(sectionId)) { message(T("This section does not exist.","此目录节点不存在。")); return false; }
        session.ui = freshUI(sectionId, language || reader.getAnchor()?.language);
        session.trail = [{type:'lookup', scrollTop:0}];
      } else if (resetLookup) {
        session.trail = [session.trail.find(page => page.type === 'lookup') || {type:'lookup', scrollTop:0}];
      }
      session.phase = currentPage()?.type || 'lookup';
      session.notice = ''; reveal(); return true;
    }
    function openChapter(sectionId, language) { return open({sectionId, language, resetLookup:true}); }
    function openDictionary() { return status === 'unavailable' ? false : open({resetLookup:true}); }
    function openBaseEntry(entryId) {
      // Only a validated canonical record may replace the incumbent entry detail.
      const id = 'dict-base-' + entryId;
      return status === 'ready' && !result.fatal.length && recordById(id) ? open({recordId:id}) : false;
    }
    function show(targetRoot) {
      root = targetRoot;
      if (visibility) render();
    }
    function hide() {
      visibility = false; options.onClose?.(); root = null;
    }
    function dismiss() {
      saveUI(); const value = releasePreview(); hide();
      value?.viewport?.({focus:false}); value?.focus?.(); notify();
    }
    function continueReading() {
      saveUI(); const value = releasePreview(); hide();
      session = null; value?.focus?.(); notify();
    }
    function endInvalidOrigin() {
      releasePreview(); hide(); session = null;
      options.onNotice?.(T("The original location or edition is no longer available. This lookup has ended; choose a location from the contents.","原阅读位置或底本已失效，旧查阅会话已结束；请从目录重新选择。"));
      notify(); return false;
    }
    function returnToOrigin() {
      if (!session || returning) return false;
      if (!currentDataset() || session.datasetId !== reader.datasetId || !reader.hasTarget(session.originAnchor)) return endInvalidOrigin();
      returning = true; saveUI(); releasePreview();
      const value = session; hide();
      let ok = false;
      try {
        ok = value.viewport ? value.viewport({focus:false}) : reader.restoreAnchor(value.originAnchor, {focus:false});
        if (ok !== false) {
          value.navigated = false; value.phase = 'lookup'; value.focus?.();
        } else {
          options.onNotice?.(T("Cannot return to the text yet. Your lookup is preserved; reopen the dictionary to continue.","暂时无法返回原文；查阅状态仍保留，可重新打开词典。"));
        }
      } catch (error) { options.onNotice?.(T("Could not return to the text: ","返回原文失败：") + error.message); }
      finally { returning = false; notify(); }
      return ok !== false;
    }
    function push(page) {
      if (!session) return;
      saveUI(); session.trail.push({...page, scrollTop:0, focusKey:'back'});
      session.phase = page.type; session.notice = ''; render(); notify();
    }
    function back() {
      if (!session || session.trail.length < 2) return;
      saveUI(); session.trail.pop(); session.phase = currentPage().type;
      session.notice = ''; render(); notify();
    }
    function navigate(target, reason, phase='source') {
      if (!session || !currentDataset()) return endInvalidOrigin();
      if (!target || !reader.hasTarget(target)) { message(T("This source location is unavailable. The text and your lookup are preserved.","此出处暂不可定位；原文与当前查阅内容已保留。")); return false; }
      saveUI(); releasePreview(); hide();
      let ok = false;
      try { ok = reader.openTarget({...target}, {reason, focus:true}) !== false; }
      catch (error) { session.notice = T("Could not open this source: ","此出处打开失败：") + error.message; }
      if (ok) { session.phase = phase; session.navigated = true; notify(); return true; }
      session.notice ||= T("This source location is unavailable. The text and your lookup are preserved.","此出处暂不可定位；原文与当前查阅内容已保留。");
      reveal(); return false;
    }
    function beforeNavigation() {
      // The reader calls this before any ordinary navigation while our panel is open.
      if (!session || !visibility) return;
      saveUI(); releasePreview(); hide();
      session.phase = 'source'; session.navigated = true; notify();
    }
    async function fetchJson(url, optional=false) {
      try {
        const response = await fetcher(url, {cache:'no-cache'});
        if (!response.ok) throw Error('HTTP ' + response.status);
        const bytes = await response.arrayBuffer();
        return {value:JSON.parse(new TextDecoder().decode(bytes)), bytes};
      } catch (error) {
        if (optional) return {value:null, error:error.message};
        throw Error(T("Could not read the local dictionary source: ","本地词典来源读取失败：") + error.message);
      }
    }
    async function load() {
      if (disposed) return;
      const token = ++serial; status = 'loading'; loadError = ''; render();
      try {
        if (!window.RedbookDictionaryCore || !window.ReadingAids) throw Error(T("The dictionary is not loaded. Use annotations or try again later.","词典核心尚未加载，请继续使用原词注或稍后重试。"));
        const [base, art, supplement] = await Promise.all([
          fetchJson(sourceUrls.aids), fetchJson(sourceUrls.artworks), fetchJson(sourceUrls.dictionary, true)
        ]);
        const [readingSha256, baseAidsSha256, artworksSha256] = await Promise.all([
          digest(readingBytes), digest(base.bytes), digest(art.bytes)
        ]);
        const baseValidation = await window.ReadingAids.validate(reading, base.value, readingSha256);
        const checked = await window.RedbookDictionaryCore.validate({
          reading, aids:base.value, artworks:art.value, dictionary:supplement.value,
          readingSha256, baseAidsSha256, artworksSha256, baseValidation
        });
        if (disposed || token !== serial) return;
        result = checked; artworks = art.value; validBindings = baseValidation.valid;
        status = 'ready';
        if (supplement.error) loadError = T("The supplementary dictionary is unavailable. Valid base entries remain available.","补充词典未加载，当前使用有效基础词典。");
      } catch (error) {
        if (disposed || token !== serial) return;
        status = 'unavailable'; loadError = error.message;
      }
      render(); notify(); return getStatus();
    }
    function definitionFor(record) {
      // English names and an English reading context prefer a reviewed English definition.
      const preferred = record.nameLanguage === 'en' || session?.originAnchor.language === 'en' ? 'en' : 'zh';
      return record.definitions.find(definition => definition.language === preferred) || record.definitions[0];
    }
    function recordMeta(record) {
      const definition = definitionFor(record);
      return (kinds()[record.kind] || T("Entry","词条")) + ' · ' + languageName(record.nameLanguage) + T(" name · "," 名称 · ") +
        (definition?.language ? languageName(definition.language) + T(" definition","释义") : T("Definition language unverified","释义语言待核对"));
    }
    function scopeText(record) {
      return record.scopeSectionIds.map(id => sectionTitle(id, record.nameLanguage)).join('；') || T("Book-wide sources","全书来源");
    }
    function entryRow(record, ref=null, category=null) {
      const article = node('article', 'dict-row');
      const term = button(record.term, () => push({type:'entry', recordId:record.id}), 'record-' + record.id, 'dict-term');
      term.lang = languageTag(record.nameLanguage); article.append(term);
      article.append(node('p', 'dict-meta', recordMeta(record)), node('p', 'dict-scope', scopeText(record)));
      const definition = definitionFor(record);
      if (definition) {
        const excerpt = node('p', 'dict-excerpt', definition.text);
        excerpt.lang = languageTag(definition.language); article.append(excerpt);
      }
      if (category === 'body' && ref) {
        const binding = validBindings.find(binding => binding.id === ref.bindingId);
        if (binding) article.append(button(T("Open this term in the text","打开此词的正文位置"), () => navigate({
          unitId:binding.unitId, language:binding.language, blockId:binding.blockId
        }, T("Dictionary text location","词典正文位置")), 'body-' + binding.id));
      }
      if (category === 'background' && ref) article.append(node('p', 'dict-meta', T("Source chapter: ","来源章节：") + sectionTitle(ref.sourceSectionId)));
      if (category === 'caption' && ref) article.append(button(T("View image description","查看图页说明"), () => push({
        type:'image', recordId:record.id, routeId:ref.routeId, imageId:ref.imageId
      }), 'image-' + ref.imageId));
      return article;
    }
    function renderSessionBar(container) {
      const bar = node('nav', 'dict-session'); bar.setAttribute('aria-label', T("Lookup navigation","查阅返回"));
      bar.append(button(T("Return to the original passage","回到刚才原文"), returnToOrigin, 'return-origin'),
        button(T("Continue reading here","在这里继续阅读"), continueReading, 'continue'));
      container.append(bar);
    }
    function renderStatus(container) {
      if (loadError || result?.fatal.length) {
        const notice = node('p', 'dict-notice', loadError || T("The supplementary dictionary does not match this edition. Valid base entries remain available.","补充词典身份不符，当前使用有效基础词典。"));
        notice.setAttribute('role', 'status'); container.append(notice);
        if (result?.fatal.length) {
          const details = node('details', 'dict-diagnostic');
          details.append(node('summary', '', T("View why it is disabled","查看停用原因")));
          for (const issue of result.fatal) details.append(node('p', '', issue.code + '：' + issue.reason));
          container.append(details);
        }
      }
      if (result?.rejected.length) container.append(node('p', 'dict-notice', result.rejected.length + T(" invalid objects or dependencies are isolated and cannot be used for navigation."," 个无效对象或依赖已隔离，不能用于导航。")));
      if (session?.notice) {
        const notice = node('p', 'dict-notice', session.notice); notice.setAttribute('role', 'alert'); container.append(notice);
      }
    }
    function selectControl(labelText, entries, value, action, key) {
      const label = node('label', 'dict-filter', labelText), select = node('select');
      select.dataset.dictKey = key;
      for (const [id, text] of entries) { const option = node('option', '', text); option.value = id; select.append(option); }
      select.value = value; select.addEventListener('change', () => action(select.value));
      label.append(select); return label;
    }
    function resetBatch() {
      session.ui.limit = 40; for (const [key] of categories()) session.ui.batches[key] = 30;
    }
    function renderLookup(container) {
      const ui = session.ui, isChapter = Boolean(ui.sectionId);
      container.append(node('h3', 'dict-title', isChapter ? sectionTitle(ui.sectionId, ui.slotLanguage) : T("People, concepts and references","全书人物、概念与典故")));
      container.append(node('p', 'dict-intro', isChapter ?
        T("Browse text, notes and image sources separately. A name appearing in a note does not imply a text annotation.","按真实来源区分正文、书注和图页。名称在书注中出现，不代表它已在正文标记。") :
        T("Search names or approved aliases. Distinct sources remain separate; linked names do not imply bilingual definitions.","检索名称或已批准的别名。相同名称的不同来源分别保留；已关联名称不代表已有双语释义。")));
      const switcher = node('div', 'dict-switcher');
      if (isChapter) switcher.append(button(T("Search all dictionary entries","查全书词典"), () => {saveUI(); ui.sectionId = null; resetBatch(); session.trail = [{type:'lookup'}]; render();}, 'all-dictionary'));
      else {
        const sectionId = units.get(session.originAnchor.unitId)?.sectionId;
        if (sectionId) switcher.append(button(T("Dictionary for the original chapter","查原阅读章词典"), () => {saveUI(); ui.sectionId = sectionId; ui.slotLanguage = session.originAnchor.language; resetBatch(); render();}, 'origin-chapter'));
      }
      container.append(switcher);
      const controls = node('div', 'dict-controls');
      const searchLabel = node('label', 'dict-search', T("Search names and aliases","检索名称与别名")), input = node('input');
      input.type = 'search'; input.placeholder = T("For example: solar barge / 太阳船","如：太阳船 / solar barge"); input.value = ui.query; input.dataset.dictKey = 'search';
      searchLabel.append(input); controls.append(searchLabel);
      const filters = node('div', 'dict-filters');
      if (isChapter) filters.append(selectControl(T("Source edition","本节点底本"), [['zh',T("Chinese","中文")], ['en','English']], ui.slotLanguage,
        value => {ui.slotLanguage = value; resetBatch(); saveUI(); render();}, 'slot-language'));
      filters.append(selectControl(T("Name language","名称语言"), [['all',T("Chinese and English","中文与 English")], ['zh',T("Chinese","中文")], ['en','English']], ui.nameLanguage,
        value => {ui.nameLanguage = value; resetBatch(); updateResults();}, 'name-language'));
      controls.append(filters); container.append(controls);
      const count = node('p', 'dict-count'), results = node('div', 'dict-results');
      count.setAttribute('aria-live', 'polite'); container.append(count, results);
      const updateResults = () => {
        results.replaceChildren();
        const found = window.RedbookDictionaryCore.search(result, {query:ui.query, nameLanguage:ui.nameLanguage});
        if (!isChapter) {
          const names = new Set(found.map(record => record.nameLanguage + ':' + record.term.toLocaleLowerCase()));
          count.textContent = names.size + T(" names · "," 个名称 · ") + found.length + T(" source records · "," 条来源记录 · ") + new Set(found.map(record => record.conceptId).filter(Boolean)).size + T(" approved concepts"," 个已批准概念");
          for (const record of found.slice(0, ui.limit)) results.append(entryRow(record));
          if (!found.length) results.append(node('p', 'dict-empty', T("No indexed names found. Try another language or consult the chapter notes.","没有找到已整理名称。可换用另一种语言名称，或查看本章原书注。")));
          if (found.length > ui.limit) results.append(button(T("Show 40 more source records","再显示 40 条来源记录"), () => {ui.limit += 40; updateResults();}, 'more-results'));
          return;
        }
        const slot = result.chaptersBySectionId.get(ui.sectionId)?.languages?.[ui.slotLanguage];
        const foundIds = new Set(found.map(record => record.id)), visibleIds = new Set();
        if (!slot) { count.textContent = T("The index for this section is unavailable.","此节点索引暂不可用。"); return; }
        if (slot.availability === 'absent') results.append(node('p', 'dict-empty', T("This edition has no section in that language. Switch editions or search all entries.","此底本无该语言节点内容。仍可切换底本或查全书词典。")));
        let references = 0;
        for (const [category, label] of categories()) {
          const refs = slot[category].filter(ref => foundIds.has(ref.recordId));
          for (const ref of refs) visibleIds.add(ref.recordId);
          references += refs.length;
          const details = node('details', 'dict-category'); details.open = ui.expanded[category];
          const summary = node('summary'), title = node('span', '', label), quantity = node('span', 'dict-quantity', new Set(refs.map(ref => ref.recordId)).size + T(" records / "," 条记录 / ") + refs.length + T(" sources"," 处来源"));
          summary.append(title, quantity); details.append(summary);
          const rows = node('div'); details.append(rows);
          const add = () => {
            rows.replaceChildren();
            for (const ref of refs.slice(0, ui.batches[category])) rows.append(entryRow(recordById(ref.recordId), ref, category));
            if (!refs.length) rows.append(node('p', 'dict-empty', T("No indexed entries match this category.","本类暂无符合条件的已整理词条。")));
            if (refs.length > ui.batches[category]) rows.append(button(T("Show 30 more sources","再显示 30 处来源"), () => {ui.batches[category] += 30; add();}, 'more-' + category));
          };
          add(); details.addEventListener('toggle', () => {ui.expanded[category] = details.open;}); results.append(details);
        }
        const records = [...visibleIds].map(recordById), body = slot.body.filter(ref => foundIds.has(ref.recordId));
        count.textContent = new Set(records.map(record => record.nameLanguage + ':' + record.term.toLocaleLowerCase())).size + T(" names · "," 个名称 · ") + records.length + T(" source records · "," 条来源记录 · ") + references + T(" categorized sources · "," 处分类来源 · ") +
          new Set(body.map(ref => ref.bindingId)).size + T(" text links / "," 个正文绑定 / ") + new Set(body.map(ref => ref.unitId)).size + T(" text units"," 个正文单元");
        if (!visibleIds.size) results.prepend(node('p', 'dict-empty', ui.query ? T("No matching entries in this section.","此节点没有匹配的已整理词条。") : T("No indexed entries in this section yet.","本节点暂无已整理词条。")));
        renderChapterNotes(results, ui.sectionId, ui.slotLanguage);
      };
      input.addEventListener('input', () => {ui.query = input.value; resetBatch(); updateResults();}); updateResults();
      container.append(node('p', 'dict-boundary', T("A complete section index does not imply line-by-line review. Entries and definitions are based on this edition’s notes.","节点入口完整不代表全章逐句审校；词条与释义据本版书注整理或译写。")));
    }
    function renderChapterNotes(container, sectionId, language) {
      const ids = sections.get(sectionId)?.noteIds?.[language] || [];
      const details = node('details', 'dict-category');
      details.append(node('summary', '', T("Source notes for this section · ","本节点原书注目录 · ") + ids.length));
      let populated = false, shown = 0;
      details.addEventListener('toggle', () => {
        if (!details.open || populated) return; populated = true;
        const list = node('div'); details.append(list);
        if (!ids.length) list.append(node('p', 'dict-empty', T("This section or edition has no source notes.","此节点 / 底本没有原书注。")));
        const more = button(T("Show more source notes","继续显示原书注"), () => add(), 'more-chapter-notes');
        const add = () => {
          more.remove();
          for (const id of ids.slice(shown, shown + 30)) {
            const note = reading.notesById[id];
            if (note) list.append(button(T("Source note ","原书注 ") + (note.label || '') + ' · ' + languageName(note.language), () => push({type:'note', noteId:id}), 'note-' + id));
          }
          shown += 30; if (shown < ids.length) list.append(more);
        }; add();
      }); container.append(details);
    }
    function renderEntry(container, page) {
      const record = recordById(page.recordId);
      if (!record) { container.append(node('p', 'dict-empty', T("This entry is unavailable. Return to search.","此词条已不可用；请返回检索。"))); return; }
      const heading = node('h3', 'dict-title', record.term); heading.lang = languageTag(record.nameLanguage); container.append(heading);
      container.append(node('p', 'dict-meta', recordMeta(record)), node('p', 'dict-scope', scopeText(record)));
      const preferred = definitionFor(record);
      const definitions = [preferred, ...record.definitions.filter(definition => definition !== preferred)].filter(Boolean);
      for (const definition of definitions) {
        const part = node('section', 'dict-definition');
        part.append(node('h4', '', definition.language ? languageName(definition.language) + T(" definition","释义") : T("Definition language unverified","释义语言待核对")));
        if (definition.language === 'mul') part.append(node('p', 'dict-meta', T("This definition contains multiple languages and is shown as written.","此说明含多种语言，按原有内容显示。")));
        const text = node('p', 'dict-definition-text', definition.text); text.lang = languageTag(definition.language); part.append(text);
        part.append(node('p', 'dict-meta', definition.reviewOrigin === 'base-aids' ?
          T("Uses the base annotation. Additional language definitions remain separate.","沿用本版基础词注说明；新增语言释义单独保留。") : T("Compiled or translated from this edition’s notes; not a verbatim quotation or expert annotation.","据本版书注整理 / 译写，非原书逐字引文或专家校注。")));
        for (const noteId of definition.sourceNoteIds || []) {
          if (reading.notesById[noteId]) part.append(noteButton(noteId, record));
        }
        container.append(part);
      }
      if (record.conceptId) {
        const concept = result.conceptsById.get(record.conceptId);
        const linked = concept?.recordIds.map(recordById).filter(other => other && other.id !== record.id) || [];
        if (linked.length) {
          const section = node('section', 'dict-linked'); section.append(node('h4', '', T("Linked names","已关联名称")));
          for (const other of linked) {
            section.append(button(other.term + ' · ' + recordMeta(other), () => push({type:'entry', recordId:other.id}), 'linked-' + other.id));
          }
          container.append(section);
        }
      }
      const sources = node('section', 'dict-sources'); sources.append(node('h4', '', T("Sources and book locations","来源与书内位置")));
      for (const route of record.sourceRoutes) renderRoute(sources, record, route);
      const bindings = validBindings.filter(binding => binding.entryId === record.baseEntryId);
      if (bindings.length) {
        const details = node('details', 'dict-category');
        details.append(node('summary', '', T("Verified text links · ","真实正文绑定 · ") + bindings.length + T(" locations / "," 处 / ") + new Set(bindings.map(binding => binding.unitId)).size + T(" units"," 个单元")));
        let shown = 0, populated = false; const list = node('div'); details.append(list);
        const more = button(T("Show 20 more text locations","再显示 20 个正文位置"), () => add(), 'more-bindings');
        const add = () => {
          more.remove();
          for (const binding of bindings.slice(shown, shown + 20)) list.append(button(sectionTitle(binding.sectionId, binding.language) + ' · ' + languageName(binding.language) + ' · ' + binding.quote,
            () => navigate({unitId:binding.unitId, language:binding.language, blockId:binding.blockId}, T("Dictionary text location","词典正文位置")), 'binding-' + binding.id));
          shown += 20; if (shown < bindings.length) list.append(more);
        };
        details.addEventListener('toggle', () => {if (details.open && !populated) {populated = true; add();}});
        sources.append(details);
      }
      container.append(sources);
    }
    function noteButton(noteId, record, routeId=null) {
      const note = reading.notesById[noteId];
      return button(T("Read full source note ","查看完整原书注 ") + (note?.label || '') + ' · ' + languageName(note?.language),
        () => push({type:'note', noteId, recordId:record?.id, routeId}), 'full-note-' + noteId);
    }
    function renderRoute(container, record, route) {
      const section = node('section', 'dict-route');
      section.append(node('p', 'dict-source-label', (route.locationKind === 'caption-background' ? T("Image note background","图页书注背景") : T("Note source","书注来源")) + ' · ' + sectionTitle(route.sectionId, route.language) + ' · ' + languageName(route.language)));
      if (reading.notesById[route.noteId]) section.append(noteButton(route.noteId, record, route.routeId));
      renderRouteActions(section, record, route);
      container.append(section);
    }
    function renderRouteActions(container, record, route) {
      for (const target of route.referenceTargets) container.append(button(T("Open a reference to this note · ","打开本注被引用的位置 · ") + languageName(target.language),
        () => navigate({unitId:target.unitId, language:target.language, blockId:target.blockId}, T("Dictionary note reference","词典原注引用位置")), 'source-' + route.routeId + '-' + target.blockId));
      if (!route.referenceTargets.length) container.append(node('p', 'dict-meta', T("No verified text reference is available. The full note can still be read.","此来源没有可核的正文引用入口，完整书注仍可查看。")));
      for (const image of route.images) container.append(button(T("View ","查看") + (image.sourceLanguage === 'zh' ? T("Chinese edition artwork","中文底本原画") : T("Source image page","底本图页")) + T(" and description","与说明"),
        () => push({type:'image', recordId:record.id, routeId:route.routeId, imageId:image.imageId}), 'route-image-' + image.imageId));
    }
    function renderNote(container, page) {
      const note = reading.notesById[page.noteId], record = recordById(page.recordId);
      if (!note) { container.append(node('p', 'dict-empty', T("This note is unavailable. Return to the entry.","此书注不可用；请返回词条。"))); return; }
      container.append(node('h3', 'dict-title', T("Full source note ","完整原书注 ") + (note.label || '')));
      container.append(node('p', 'dict-meta', sectionTitle(note.sectionId, note.language) + ' · ' + languageName(note.language) + T(" source note","底本原注")));
      const body = node('div', 'dict-note-text'); body.lang = languageTag(note.language); container.append(body);
      const owner = units.get(session.originAnchor.unitId);
      if (options.renderNotes) options.renderNotes([note], body, owner, back);
      else {
        for (const paragraph of note.paragraphs || [note.text]) body.append(node('p', '', typeof paragraph === 'string' ? paragraph : paragraph?.text || ''));
        // The production hook passes the reader's renderer to preserve inline source images.
      }
      if (record) {
        const routes = page.routeId ? [routeById(record, page.routeId)].filter(Boolean) : record.sourceRoutes.filter(route => route.noteId === note.id);
        for (const route of routes) renderRouteActions(container, record, route);
      }
    }
    function imageTarget(item) {
      return item?.readingTargets.find(target => target.relation === 'insertion' && target.mappingStatus === 'verified-source-position')?.anchor || null;
    }
    function renderImage(container, page) {
      const record = recordById(page.recordId), route = routeById(record, page.routeId);
      const image = route?.images.find(image => image.imageId === page.imageId), item = artworkById(page.imageId);
      if (!image || !item || item.asset.sha256 !== image.assetSha256) {
        container.append(node('p', 'dict-empty', T("The image identity is unavailable. No other image was substituted.","图页身份不可用；未猜配其他图片。"))); return;
      }
      container.append(node('h3', 'dict-title', image.sourceLanguage === 'zh' ? T("Chinese edition artwork","中文底本原画") : T("Source image page","底本图页")));
      container.append(node('p', 'dict-intro', T("The image description references this topic; it does not label regions within the image.","图页说明涉及此主题；这不是图内区域的语义标注。")));
      const raw = reader.dataset === 'candidate' ? item.asset.candidateUrl : item.asset.url;
      const url = new URL(raw, location.origin), prefix = reader.dataset === 'candidate' ? '/candidate/assets/' : '/data/fullbook-assets/';
      if (url.origin === location.origin && url.pathname.startsWith(prefix) && !decodeURIComponent(url.pathname).includes('..')) {
        const figure = node('figure', 'dict-image'), img = node('img'); img.src = url.href; img.alt = item.alt; img.loading = 'lazy';
        img.width = item.asset.width; img.height = item.asset.height;
        img.addEventListener('error', () => img.replaceWith(node('p', 'dict-empty', T("Could not load the local image. Return to the note or reopen the image.","本地图像读取失败；可返回书注或重试打开图页。"))));
        figure.append(img, node('figcaption', '', item.marker + ' · ' + item.attribution)); container.append(figure);
      } else container.append(node('p', 'dict-empty', T("The local image path is unavailable. No external image was requested.","本地图像路径不可用；未发起外部图片请求。")));
      const target = imageTarget(item);
      const openImage = button(T("Open the source image page","打开真实书内图页"), () => navigate(target, T("Dictionary image page","词典书内图页"), 'image'), 'open-image-page');
      if (!target || !reader.hasTarget(target)) {openImage.disabled = true; container.append(node('p', 'dict-empty', T("This image has no verified book location.","此图暂没有可核的书内位置。")));}
      container.append(openImage, noteButton(route.noteId, record, route.routeId));
    }
    function render() {
      if (!root || !session || !visibility || disposed) return;
      root.replaceChildren(); const container = node('section', 'reading-dictionary'); root.append(container);
      renderSessionBar(container); renderStatus(container);
      if (status !== 'ready') {
        container.append(node('p', 'dict-empty', status === 'loading' ? T("Checking the local dictionary and source edition…","正在核对本地词典与底本身份…") : loadError || T("The dictionary is not ready.","词典尚未准备。")));
        if (status !== 'loading') container.append(button(T("Reload dictionary","重新读取词典"), load, 'retry'));
        return;
      }
      const page = currentPage();
      if (!page) return;
      if (session.trail.length > 1) container.append(button(T("Back to the previous lookup","返回上一层查阅"), back, 'back'));
      if (page.type === 'lookup') renderLookup(container);
      else if (page.type === 'entry') renderEntry(container, page);
      else if (page.type === 'note') renderNote(container, page);
      else if (page.type === 'image') renderImage(container, page);
      root.scrollTop = page.scrollTop || 0;
      if (page.focusKey) {
        [...root.querySelectorAll('[data-dict-key]')].find(element => element.dataset.dictKey === page.focusKey)?.focus({preventScroll:true});
      }
    }
    function getSessionState() {
      return session ? {
        datasetId:session.datasetId, originAnchor:{...session.originAnchor}, phase:session.phase,
        navigated:session.navigated, visible:visibility, ui:clone(session.ui),
        path:session.trail.map(page => ({...page})), paused:Boolean(preview)
      } : null;
    }
    function getStatus() {
      return {status, error:loadError, fatal:result?.fatal || [], rejected:result?.rejected || [],
        records:result?.records.length || 0, concepts:result?.concepts.length || 0, nodes:result?.chapterIndex.length || 0};
    }
    const unsubscribeLocale=window.FoliotterI18n?.subscribe(()=>{if(visibility){saveUI();render();}});
    function dispose() { unsubscribeLocale?.();disposed = true; serial++; releasePreview(); hide(); session = null; result = null; }
    const api = {load, open, openChapter, openDictionary, openBaseEntry, show, dismiss, continueReading, beforeNavigation,
      returnToOrigin, getSessionState, getStatus, dispose};
    if (options.autoLoad !== false) load();
    return Object.freeze(api);
  }
  window.ReadingDictionary = Object.freeze({version:1, create});
})();
