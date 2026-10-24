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
