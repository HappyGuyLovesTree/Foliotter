'use strict';
/* Translate only the records module's public notices at their display boundary. */
(() => {
  const messages = new Map([
    ['作者未注明', 'Author not provided'],
    ['作者未标注', 'Author not provided'],
    ['未命名电子书', 'Untitled book'],
    ['文件含不允许的对象键', 'The file contains a disallowed object key.'],
    ['JSON格式损坏，请重新选择备份文件', 'The JSON is damaged. Choose the backup file again.'],
    ['记录版本不支持', 'This records version is not supported.'],
    ['单元标识格式错误', 'A reading unit ID has an invalid format.'],
    ['笔记必须是文字', 'Notes must contain text.'],
    ['历史记录格式错误', 'The reading history has an invalid format.'],
    ['当前位置格式错误', 'The current reading position has an invalid format.'],
    ['今日记录格式错误', 'Today’s reading record has an invalid format.'],
    ['阅读位置格式错误', 'A saved reading position has an invalid format.'],
    ['访问记录格式错误', 'The visited-unit records have an invalid format.'],
    ['冲突记录格式错误', 'The conflict records have an invalid format.'],
    ['旧记录格式错误', 'The legacy records have an invalid format.'],
    ['旧当前位置格式错误', 'The legacy current reading position has an invalid format.'],
    ['旧位置格式错误', 'A legacy reading position has an invalid format.'],
    ['已保存记录属于不同书籍或底本，原记录已保留', 'The saved records belong to a different book or source edition. The original records have been kept.'],
    ['只读备份模式：阅读与操作不会改写已保存记录。', 'Read-only backup mode: reading and other actions will not change the saved records.'],
    ['另一阅读页正在保存记录，本页已停止写入；请先导出本页备份，再关闭其他阅读页并刷新', 'Another reading page is saving records. This page has stopped writing. Export a backup from this page, then close the other reading pages and refresh.'],
    ['其他标签或窗口已更改记录，本页已停止保存以保护双方内容', 'Another tab or window changed the records. This page has stopped saving to protect both versions.'],
    ['旧记录备份回读失败', 'The legacy-record backup could not be verified after saving.'],
    ['保存回读不一致', 'The saved records did not match when read back.'],
    ['当前为只读状态；原记录未改写', 'This page is read-only. The original records have not changed.'],
    ['本页记录已停止写入', 'This page has stopped saving records.'],
    ['备份文件超过10MiB', 'The backup file exceeds 10 MiB.'],
    ['不是支持的红书记录备份（版本2）', 'This is not a supported reading-records backup (version 2).'],
    ['备份属于另一部书', 'The backup belongs to another book.'],
    ['备份底本不同，不能直接恢复', 'The backup uses a different source edition and cannot be restored directly.'],
    ['备份内部书籍身份不一致', 'The book identities inside the backup do not match.'],
    ['恢复预检无效，请重新选择备份', 'The restore preview is no longer valid. Choose the backup again.'],
    ['预检后记录已变化，请重新选择备份并检查', 'The records changed after the preview. Choose the backup again and review it.'],
    ['仅按 EPUB spine 文件划分章节；章节内文字按原序保留。', 'Sections follow EPUB spine files; text keeps its source order.'],
    ['不保留原版式、链接、交互、媒体、脚注跳转或自动双语配对。', 'Original layout, links, interactive media and note navigation are not retained; no bilingual alignment is created.'],
    ['SVG 和无法验证的图片会跳过。', 'SVG and unverified images are skipped.'],
    ['PDF 文字按原文件页码分组；分栏、公式与版式可能不同。', 'PDF text is grouped by source page. Columns, formulas and layout may differ.'],
    ['不含图片或 OCR 识别；原文不会被翻译。', 'Images and OCR are not included; source text is not translated.'],
    ['导入 FB2 文字及安全的位图；不保留原版式和脚注链接。', 'FB2 text and safe raster images are imported; original layout and note links are not preserved.'],
    ['使用独立的 KindleUnpack 命令行工具在本机转换；原版式和脚注链接可能不同。', 'Converted locally with the standalone KindleUnpack CLI; original layout and note links may differ.']
  ]);
  const recovery = '本页修改仍在会话中。请打开“备份与恢复”导出本页备份，再刷新读取最新记录；需要时选择该备份合并恢复并处理笔记冲突。';
  const recoveryEnglish = 'Your changes are still in this session. Open “Backup and restore” to export this page’s backup, then refresh to read the latest records. If needed, select that backup to merge it and resolve note conflicts.';
  const preserved = '。原记录保留，本次修改仅在会话中；请先导出备份。';
  const noLocks = '当前浏览器不支持安全的多标签保存。请使用支持 Web Locks 的浏览器打开本页。';
  messages.set(recovery, recoveryEnglish);
  messages.set(noLocks + recovery, 'This browser does not support safe saving across tabs. Open this page in a browser that supports Web Locks. ' + recoveryEnglish);
  const chineseMessages = new Map([...messages].map(([zh, en]) => [en, zh]));
  const fields = new Set(['queue', 'history', 'favorites', 'orphans', 'notes', 'positions', 'visited', 'today']);
  const legacyFields = new Set(['queue', 'history', 'favorites', 'notes', 'positions', 'today']);

  function known(message, depth = 0) {
    if (messages.has(message)) return messages.get(message);
    const field = /^记录字段 ([a-z]+) 格式错误$/.exec(message);
    if (field && fields.has(field[1])) return `The “${field[1]}” records field has an invalid format.`;
    const legacy = /^旧记录 ([a-z]+) 格式错误$/.exec(message);
    if (legacy && legacyFields.has(legacy[1])) return `The legacy “${legacy[1]}” records field has an invalid format.`;
    // Only recognized prefixes may form a translated notice. Unknown errors and
    // arbitrary user text remain byte-for-byte unchanged, even with this suffix.
    if (depth < 3) {
      for (const [suffix, translation] of [
        [preserved, 'The original records have been kept. Changes are only in this session; export a backup first.'],
        ['。' + recovery, recoveryEnglish]
      ]) {
        if (!message.endsWith(suffix)) continue;
        const prefix = known(message.slice(0, -suffix.length), depth + 1);
        if (prefix !== null) return prefix + ' ' + translation;
      }
    }
    return null;
  }

  function text(message) {
    if (typeof message !== 'string') return message;
    if (window.FoliotterI18n?.getLocale() === 'zh') return chineseMessages.get(message) ?? message;
    return known(message) ?? message;
  }
  window.FoliotterRecordNotices = Object.freeze({text});
})();
