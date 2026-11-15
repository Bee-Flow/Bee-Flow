/**
 * Windmill event filters (Mongo-like, as webhook_listeners reads them) to Bee
 * Flow trigger filters (mapFilter.mts). The regular expressions are taken
 * apart as text, never run.
 *
 * Run: cd server && node --test automation/importers/windmill/mapFilter.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { mapEventFilter, stripUserFilesPrefix, folderOf } = require('./mapFilter.mts');

test('a folder pattern on the internal path becomes inFolder', () => {
    for (const pattern of ['/^\\/[^\\/]+\\/files\\/Uploads\\/.*$/', '/^\\/.*\\/files\\/Uploads\\/.*$/', '/^\\/office\\/files\\/Uploads\\//']) {
        assert.deepStrictEqual(mapEventFilter('file.new', { 'event.node.path': pattern }), { kind: 'filter', filter: { inFolder: '/Uploads' }, notes: [] }, pattern);
    }
    assert.deepStrictEqual(mapEventFilter('file.new', { 'event.node.path': '/^\\/.*\\/files\\/A\\.B\\/Sub\\/.*$/' }).filter, { inFolder: '/A.B/Sub' });
});

test('another path pattern is a regexMatch on the path inside the user\'s files', () => {
    const r = mapEventFilter('file.new', { 'event.node.path': '/^\\/[^\\/]+\\/files\\/.*\\.pdf$/i' });
    assert.deepStrictEqual(r.filter, { expr: 'regexMatch(trigger.path, "^\\\\/.*\\\\.pdf$", "i")' });
    assert.strictEqual(r.notes.length, 1);
});

test('a pattern Bee Flow cannot read goes to the AI builder', () => {
    assert.strictEqual(mapEventFilter('file.new', { 'event.node.path': '/^\\/a\\/files\\/(?=x).*/' }).kind, 'ai');
    assert.strictEqual(mapEventFilter('file.new', { 'event.node.path': '/Uploads/' }).kind, 'ai');
    assert.strictEqual(mapEventFilter('file.new', { $nor: [] }).kind, 'ai');
    assert.strictEqual(mapEventFilter('file.new', { 'event.node.size': { $gt: 3 } }).kind, 'ai');
});

test('form, table and tag keys become structured filter keys', () => {
    assert.deepStrictEqual(mapEventFilter('forms.submitted', { 'event.form.hash': 'h1', 'event.form.id': 4 }).filter, { formHash: 'h1', formId: 4 });
    assert.deepStrictEqual(mapEventFilter('forms.submitted', { 'event.submission.formId': 4 }).filter, { formId: 4 });
    assert.deepStrictEqual(mapEventFilter('tables.row.added', { 'event.tableId': 7 }).filter, { tableId: 7 });
    assert.deepStrictEqual(mapEventFilter('file.tagged', { 'event.tagId': 5 }).filter, { tagId: 5 });
});

test('$in, comparisons, $or and the user id filter become a rule', () => {
    assert.deepStrictEqual(mapEventFilter('forms.submitted', { 'event.form.id': { $in: [1, 2] } }, 'bob').filter,
        { expr: '(trigger.formId == 1 || trigger.formId == 2) && (trigger.actor == "bob")' });
    assert.deepStrictEqual(mapEventFilter('tables.row.updated', { 'event.rowId': { $gte: 10 } }).filter, { expr: 'trigger.rowId >= 10' });
    assert.deepStrictEqual(mapEventFilter('tables.row.added', { $or: [{ 'event.tableId': 1 }, { 'event.tableId': 2 }] }).filter,
        { expr: '((trigger.tableId == 1)) || ((trigger.tableId == 2))' });
    assert.deepStrictEqual(mapEventFilter('file.new', {}, 'alice').filter, { expr: 'trigger.actor == "alice"' });
    assert.deepStrictEqual(mapEventFilter('file.new', undefined).filter, {});
});

test('the user files prefix and the folder are read as text', () => {
    assert.strictEqual(stripUserFilesPrefix('^\\/alice\\/files\\/Docs\\/'), '\\/Docs\\/');
    assert.strictEqual(stripUserFilesPrefix('^/[^/]+/files/x'), '/x');
    assert.strictEqual(stripUserFilesPrefix('^\\/alice\\/other\\/'), null);
    assert.strictEqual(stripUserFilesPrefix('\\/alice\\/files\\/'), null);
    assert.strictEqual(folderOf('\\/Docs\\/.*$'), '/Docs');
    assert.strictEqual(folderOf('\\/Do.s\\/'), null);
    assert.strictEqual(folderOf('\\/Docs\\/.*\\.pdf$'), null);
});
