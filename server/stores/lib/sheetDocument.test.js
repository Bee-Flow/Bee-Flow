// @typecheck
/**
 * The settings a tab write stores (settingsWithTabs): everything on the
 * sheet kept, charts pinned to a tab that is gone dropped.
 *
 * Run: cd server && node --test stores/lib/sheetDocument.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { settingsWithTabs } = require('./sheetDocument');

const tabs = [{ id: 't1', name: 'Main', datatableId: 'dt1' }, { id: 't2', name: 'Costs', datatableId: 'dt2' }];

test('a tab write keeps the rest of the sheet and of the settings', () => {
    const settings = { houseStyle: 'x', sheet: { tabs: [tabs[0]], charts: [{ id: 'c1', tab: 't1' }], extra: 1 } };
    assert.deepStrictEqual(settingsWithTabs(settings, tabs), { houseStyle: 'x', sheet: { tabs, charts: [{ id: 'c1', tab: 't1' }], extra: 1 } });
    assert.deepStrictEqual(settingsWithTabs({}, tabs), { sheet: { tabs } }, 'no charts key appears out of nothing');
});

test('charts of a tab that is no longer listed go, older orphans included; tab-less charts stay', () => {
    const settings = { sheet: { tabs, charts: [{ id: 'c1', tab: 't1' }, { id: 'c2', tab: 't2' }, { id: 'orphan', tab: 'deleted-long-ago' }, { id: 'all' }] } };
    assert.deepStrictEqual(settingsWithTabs(settings, [tabs[1]]).sheet.charts.map((c) => c.id), ['c2', 'all']);
    assert.deepStrictEqual(settingsWithTabs(settings, tabs).sheet.charts.map((c) => c.id), ['c1', 'c2', 'all'], 'the next tab write cleans up an orphan');
});

test('a single-table sheet keeps the charts pinned to its implicit default tab', () => {
    const settings = { sheet: { datatableId: 'dt1', charts: [{ id: 'c1', tab: 'default' }] } };
    const out = settingsWithTabs(settings, [{ id: 'default', name: 'Sheet1', datatableId: 'dt1' }, tabs[1]]);
    assert.deepStrictEqual(out.sheet.charts.map((c) => c.id), ['c1']);
    assert.strictEqual(out.sheet.datatableId, 'dt1');
});

// ═══ keepSheetOnUpdate: a save may rename and reorder tabs, never re-point them ═══

const { keepSheetOnUpdate } = require('./sheetDocument');
const failure = (message, status, errorClass) => Object.assign(new Error(message), { status, errorClass });
const sheetDoc = () => ({ docType: 'spreadsheet', settings: { sheet: { tabs: tabs.map((t) => ({ ...t })), charts: [{ id: 'c1', tab: 't1' }] } } });

test('a save renames and reorders the existing tabs; each keeps its own table, whatever was sent', () => {
    const next = { settings: { sheet: { tabs: [{ id: 't2', name: 'Kosten', datatableId: 'owners-other-table' }, { id: 't1', name: 'Main', datatableId: 'dt1' }] } } };
    keepSheetOnUpdate(sheetDoc(), next, 'spreadsheet', failure);
    assert.deepStrictEqual(next.settings.sheet.tabs, [{ id: 't2', name: 'Kosten', datatableId: 'dt2' }, { id: 't1', name: 'Main', datatableId: 'dt1' }]);
    assert.deepStrictEqual(next.settings.sheet.charts, [{ id: 'c1', tab: 't1' }], 'the rest of the sheet stays');
});

test('a save cannot add or drop a tab: unknown or missing tab ids are refused', () => {
    const refused = (e) => e.status === 422 && e.errorClass === 'sheet_tabs_fixed';
    assert.throws(() => keepSheetOnUpdate(sheetDoc(), { settings: { sheet: { tabs: [...tabs, { id: 'evil', name: 'X', datatableId: 'owners-other-table' }] } } }, 'spreadsheet', failure), refused);
    assert.throws(() => keepSheetOnUpdate(sheetDoc(), { settings: { sheet: { tabs: [tabs[0]] } } }, 'spreadsheet', failure), refused);
    assert.throws(() => keepSheetOnUpdate(sheetDoc(), { settings: { sheet: { tabs: [tabs[0], tabs[0]] } } }, 'spreadsheet', failure), refused);
    assert.throws(() => keepSheetOnUpdate(sheetDoc(), { settings: { sheet: { tabs: 'all' } } }, 'spreadsheet', failure), refused);
});

test('a save without tabs keeps the tabs as they are', () => {
    const next = { settings: { sheet: { charts: [] } } };
    keepSheetOnUpdate(sheetDoc(), next, 'spreadsheet', failure);
    assert.deepStrictEqual(next.settings.sheet.tabs, tabs);
});

test('server code that made or dropped the tables itself may add and remove tabs; existing tabs still keep their table', () => {
    const next = { settings: { sheet: { tabs: [{ id: 't1', name: 'Main', datatableId: 'elsewhere' }, { id: 't3', name: 'New', datatableId: 'dt3' }] } } };
    keepSheetOnUpdate(sheetDoc(), next, 'spreadsheet', failure, { tabsChangedByServer: true });
    assert.deepStrictEqual(next.settings.sheet.tabs, [{ id: 't1', name: 'Main', datatableId: 'dt1' }, { id: 't3', name: 'New', datatableId: 'dt3' }]);
});

test('an old single-table sheet answers to its implicit default tab', () => {
    const current = { docType: 'spreadsheet', settings: { sheet: { datatableId: 'dt1' } } };
    const next = { settings: { sheet: { tabs: [{ id: 'default', name: 'Renamed', datatableId: 'other' }] } } };
    keepSheetOnUpdate(current, next, 'spreadsheet', failure);
    assert.deepStrictEqual(next.settings.sheet.tabs, [{ id: 'default', name: 'Renamed', datatableId: 'dt1' }]);
    assert.strictEqual(next.settings.sheet.datatableId, 'dt1');
});

// ═══ locale: how the sheet reads typed numbers, fixed at creation ═══

const { sheetSettingsForCreate, sheetLocaleOf } = require('./sheetDocument');

test('a new sheet takes its creator\'s language for reading numbers; none given stays without one (en)', () => {
    const nl = sheetSettingsForCreate({}, 'spreadsheet', 'dt1', failure, { tabName: 'Blad1', locale: 'nl-NL' });
    assert.strictEqual(nl.sheet.locale, 'nl');
    assert.strictEqual(nl.sheet.tabs[0].name, 'Blad1');
    assert.strictEqual(sheetSettingsForCreate({}, 'spreadsheet', 'dt1', failure, { locale: 'de' }).sheet.locale, 'en');
    const none = sheetSettingsForCreate({}, 'spreadsheet', 'dt1', failure);
    assert.strictEqual(none.sheet.locale, undefined);
    assert.strictEqual(sheetLocaleOf({ settings: none }), 'en', 'a sheet without a locale reads as en');
    assert.strictEqual(sheetLocaleOf({ settings: nl }), 'nl');
    assert.strictEqual(sheetLocaleOf(null), 'en');
});

test('saves and tab writes keep the sheet\'s locale', () => {
    const current = { docType: 'spreadsheet', settings: { sheet: { tabs, locale: 'nl' } } };
    const next = { settings: { sheet: { tabs: [tabs[1], tabs[0]], charts: [] } } };
    keepSheetOnUpdate(current, next, 'spreadsheet', failure);
    assert.strictEqual(next.settings.sheet.locale, 'nl');
    const noSheet = /** @type {any} */ ({ settings: { houseStyle: true } });
    keepSheetOnUpdate(current, noSheet, 'spreadsheet', failure);
    assert.strictEqual(noSheet.settings.sheet.locale, 'nl');
    assert.strictEqual(settingsWithTabs(current.settings, [tabs[0]]).sheet.locale, 'nl');
});
