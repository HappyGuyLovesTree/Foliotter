'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../app', name), 'utf8');
const recordsSource = source('records.js');
function harness(locale = 'en') {
  const context = {window: {}, TextEncoder, Intl, console};
  context.window.FoliotterI18n = {getLocale: () => locale};
  vm.createContext(context);
  vm.runInContext(recordsSource, context);
  vm.runInContext(source('reader-notices.js'), context);
  return {records: context.window.RedbookRecords, text: context.window.FoliotterRecordNotices.text, locale: value => {locale = value;}};
}
const data = {metadata: {bookId: 'fixture', datasetId: 'fixture-v1'}, units: [{id: 'u1'}]};
const storage = {getItem: () => null};

test('all fixed errors from the protected records module have display translations', () => {
  const app = harness();
  const messages = [...recordsSource.matchAll(/Error\('([^']+)'\)/g)].map(match => match[1]);
  assert.ok(messages.length > 20);
  for (const message of messages) {
    assert.notEqual(app.text(message), message, message);
    assert.doesNotMatch(app.text(message), /[\u3400-\u9fff]/, message);
  }
  app.locale('zh');
  for (const message of messages) assert.equal(app.text(message), message);
});

test('validation and migration fields are translated only for explicit record keys', () => {
  const app = harness();
  for (const key of ['queue', 'history', 'favorites', 'orphans', 'notes', 'positions', 'visited', 'today']) {
    const state = app.records.empty(data); state[key] = null;
    assert.throws(() => app.records.validate(state), error => {
      assert.match(app.text(error.message), new RegExp(`“${key}” records field`)); return true;
    });
  }
  for (const key of ['queue', 'history', 'favorites', 'notes', 'positions', 'today']) {
    assert.throws(() => app.records.migrate(JSON.stringify({[key]: 12}), data), error => {
      assert.match(app.text(error.message), new RegExp(`legacy “${key}”`)); return true;
    });
  }
  for (const message of ['记录字段 user_note 格式错误', '记录字段 constructor 格式错误', '旧记录 visited 格式错误']) assert.equal(app.text(message), message);
});

test('real corrupt-record and unsupported-browser notices retain recovery instructions', () => {
  const app = harness();
  const corrupt = app.records.open(data, {storage: {getItem: key => key === 'redbook.reader.v2' ? '{broken' : null}});
  assert.match(app.text(corrupt.notice), /^The JSON is damaged/);
  assert.match(app.text(corrupt.notice), /export a backup first/);
  const noLocks = app.records.open(data, {storage});
  assert.match(app.text(noLocks.notice), /supports Web Locks/);
  assert.match(app.text(noLocks.notice), /resolve note conflicts/);
  const readonly = app.records.open(data, {storage, readonly: true});
  assert.match(app.text(readonly.notice), /^Read-only backup mode/);
  app.locale('zh'); assert.equal(app.text(corrupt.notice), corrupt.notice);
});

test('known save failures combine safely with their fixed recovery suffix', async () => {
  const app = harness();
  const store = app.records.open(data, {storage, locks: {request: async (_name, _options, fn) => fn(null)}});
  store.state.notes.u1 = '原笔记：不得翻译。';
  assert.equal(await store.persist(), false);
  assert.match(app.text(store.notice), /Another reading page is saving/);
  assert.match(app.text(store.notice), /export this page’s backup/);
  assert.equal(store.export().state.notes.u1, '原笔记：不得翻译。');
  await store.close();
});

test('backup errors translate without changing exported metadata or notes', () => {
  const app = harness();
  const store = app.records.open(data, {storage, readonly: true});
  store.state.notes.u1 = '备份属于另一部书';
  const backup = store.export();
  const before = JSON.stringify(backup);
  backup.bookId = 'other';
  assert.throws(() => store.preview(JSON.stringify(backup)), error => {
    assert.equal(app.text(error.message), 'The backup belongs to another book.'); return true;
  });
  backup.bookId = data.metadata.bookId;
  assert.equal(JSON.stringify(backup), before);
  assert.equal(store.state.notes.u1, '备份属于另一部书');
});

test('unknown errors and user text pass through unchanged without DOM access', () => {
  const app = harness();
  for (const value of [undefined, null, 12, {note: '备份属于另一部书'}, '', 'Unrecognized error', '我的笔记：备份属于另一部书', '未知错误。原记录保留，本次修改仅在会话中；请先导出备份。']) assert.equal(app.text(value), value);
  assert.equal(source('records.js'), recordsSource);
  const context = {window: {}}; vm.createContext(context); vm.runInContext(source('reader-notices.js'), context);
  assert.equal(context.window.FoliotterRecordNotices.text('备份属于另一部书'), 'The backup belongs to another book.');
});

test('import limitation notices translate both ways without translating unknown book text', () => {
  const app = harness();
  const files = ['epub_import.py', 'book_import.py'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8'));
  const notices = files.flatMap(code => [...code.matchAll(/'limitations': \[([^\]]+)\]/g)].flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1])));
  assert.ok(notices.length >= 7);
  for (const notice of notices) {
    const sourceIsChinese = /[\u3400-\u9fff]/.test(notice);
    app.locale(sourceIsChinese ? 'en' : 'zh');
    const translated = app.text(notice); assert.notEqual(translated, notice);
    app.locale(sourceIsChinese ? 'zh' : 'en'); assert.equal(app.text(translated), notice);
  }
  const unknown = 'An unknown publisher’s book description.';
  app.locale('zh'); assert.equal(app.text(unknown), unknown);
});

test('legacy generated metadata placeholders translate without matching actual metadata substrings', () => {
  const app=harness();
  for(const author of ['作者未注明','作者未标注']) assert.equal(app.text(author),'Author not provided');
  assert.equal(app.text('未命名电子书'),'Untitled book');
  for(const value of ['作者未注明自己的名字','未命名电子书的故事','A real author']) assert.equal(app.text(value),value);
  app.locale('zh');assert.equal(app.text('Untitled book'),'未命名电子书');assert.equal(app.text('Author not provided'),'作者未标注');
});
