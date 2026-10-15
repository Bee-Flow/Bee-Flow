/**
 * sheetChartSpec — charts the chat puts in a spreadsheet: checked like the
 * assistant's add_chart, pinned to the tab they read, stored on top of the
 * newest settings.
 *
 * Run: cd server && node --test core/documents/sheetChartSpec.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chartsFrom, addCharts, chartSummary, MAX_CHARTS, CHART_TYPES } = require('./sheetChartSpec');

test('a chart is checked and pinned to its tab', () => {
    const out = chartsFrom([{ type: 'pie', dataRange: 'b2:b5', categoriesRange: 'A2:A5', anchor: 'e2', title: 'Segmenten' }], 't9', []);
    assert.strictEqual(out.charts.length, 1);
    const [c] = out.charts;
    assert.match(c.id, /^chart-[0-9a-f]{10}$/);
    assert.deepStrictEqual({ ...c, id: 'x' }, { id: 'x', type: 'pie', dataRange: 'B2:B5', categoriesRange: 'A2:A5', anchor: 'E2', title: 'Segmenten', width: 672, height: 392, tab: 't9' });
});

test('wrong types, ranges, anchors and too many charts are explained', () => {
    assert.match(chartsFrom([{ type: 'donut', dataRange: 'B2:B5', anchor: 'E2' }], 't', []).error, /type must be one of/);
    assert.match(chartsFrom([{ type: 'bar', dataRange: 'Klanten!B2', anchor: 'E2' }], 't', []).error, /dataRange/);
    assert.match(chartsFrom([{ type: 'bar', dataRange: 'B2:B5', anchor: 'E2:F9' }], 't', []).error, /anchor/);
    assert.match(chartsFrom([{ type: 'bar', dataRange: 'B2:B5', anchor: 'E2' }], 't', Array.from({ length: MAX_CHARTS }, (_, i) => ({ id: `c${i}` }))).error, /at most/);
    assert.match(chartsFrom([], 't', []).error, /list/);
});

test('stored on the newest settings, keeping the charts already there', async () => {
    const updates = [];
    const documents = {
        async getDocument() { return { id: 'd1', versionId: 'v3', settings: { sheet: { tabs: [{ id: 't1' }, { id: 't2' }], charts: [{ id: 'old' }] } } }; },
        async updateDocument(id, actor, u) { updates.push([id, actor, u]); return { id }; },
    };
    const res = await addCharts({ id: 'd1', userId: 'owner', versionId: 'v1', settings: {} }, [{ id: 'new' }], { documents, actorUserId: 'editor' });
    assert.deepStrictEqual(res, { saved: 1, updated: 0, removed: 0 });
    const [id, actor, u] = updates[0];
    assert.strictEqual(id, 'd1');
    assert.strictEqual(actor, 'editor');
    assert.strictEqual(u.expectedVersionId, 'v3');
    assert.deepStrictEqual(u.settings.sheet.tabs.map((t) => t.id), ['t1', 't2'], 'a tab added earlier in the call is kept');
    assert.deepStrictEqual(u.settings.sheet.charts.map((c) => c.id), ['old', 'new']);
});

test('the new types are accepted; scatter needs categoriesRange', () => {
    for (const type of CHART_TYPES) {
        const out = chartsFrom([{ type, dataRange: type === 'kpi' ? 'B2' : 'B2:C5', categoriesRange: 'A2:A5', anchor: 'E2' }], 't', []);
        assert.strictEqual(out.charts?.[0]?.type, type, type);
    }
    assert.deepStrictEqual(CHART_TYPES, ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'stacked', 'kpi']);
    assert.match(chartsFrom([{ type: 'scatter', dataRange: 'B2:B5', anchor: 'E2' }], 't', []).error, /scatter chart needs categoriesRange/);
});

test('size in cells or px, style fields and kpi checks', () => {
    const [c] = chartsFrom([{ type: 'bar', dataRange: 'B2:B5', anchor: 'E2', size: { cols: 4, rows: 10 }, format: 'currency', currency: 'usd', colors: ['#112233'], showValues: true }], 't', []).charts;
    assert.deepStrictEqual([c.width, c.height, c.format, c.currency, c.colors, c.showValues], [448, 280, 'currency', 'USD', ['#112233'], true]);
    const px = chartsFrom([{ type: 'bar', dataRange: 'B2:B5', anchor: 'E2', width: 99999, height: 10 }], 't', []).charts[0];
    assert.deepStrictEqual([px.width, px.height], [1400, 80]);
    assert.match(chartsFrom([{ type: 'bar', dataRange: 'B2:B5', anchor: 'E2', colors: ['red'] }], 't', []).error, /hex/);
    assert.match(chartsFrom([{ type: 'bar', dataRange: 'B2:B5', anchor: 'E2', format: 'x' }], 't', []).error, /format/);
    assert.match(chartsFrom([{ type: 'kpi', dataRange: 'B2:B5', anchor: 'E2' }], 't', []).error, /ONE cell/);
    const k = chartsFrom([{ type: 'kpi', dataRange: 'b2', compareRange: 'c2', label: 'Revenue', anchor: 'A1', size: { cols: 2, rows: 4 } }], 't', []).charts[0];
    assert.deepStrictEqual([k.dataRange, k.compareRange, k.label], ['B2', 'C2', 'Revenue']);
});

test('an id updates a chart on this tab, removeCharts deletes, and both are saved', async () => {
    const existing = [{ id: 'a', type: 'bar', dataRange: 'B2:B5', anchor: 'E2', width: 672, height: 392, tab: 't1' }, { id: 'b', type: 'pie', dataRange: 'B2:B5', anchor: 'E20', width: 1, height: 1, tab: 't1' }];
    const out = chartsFrom([{ id: 'a', type: 'doughnut', anchor: 'k2', size: { cols: 3, rows: 5 } }], 't1', existing, ['b']);
    assert.deepStrictEqual(out.updated.map((c) => [c.id, c.type, c.anchor, c.width, c.height, c.dataRange]), [['a', 'doughnut', 'K2', 336, 140, 'B2:B5']]);
    assert.deepStrictEqual(out.removed, ['b']);
    assert.match(chartsFrom([{ id: 'zz', type: 'bar' }], 't1', existing).error, /no chart "zz"/);
    assert.match(chartsFrom([], 't1', existing, ['nope']).error, /no chart "nope"/);
    const updates = [];
    const documents = {
        async getDocument() { return { id: 'd', versionId: 'v', settings: { sheet: { charts: existing } } }; },
        async updateDocument(id, actor, u) { updates.push(u); return { id }; },
    };
    assert.deepStrictEqual(await addCharts({ id: 'd', userId: 'o' }, out.charts, { documents }, out), { saved: 0, updated: 1, removed: 1 });
    assert.deepStrictEqual(updates[0].settings.sheet.charts.map((c) => [c.id, c.type]), [['a', 'doughnut']]);
});

test('an update only reaches a chart on this tab (or one without a tab), and never one being removed', () => {
    const existing = [{ id: 'a', type: 'bar', dataRange: 'B2:B5', anchor: 'E2', width: 672, height: 392, tab: 't1' }, { id: 'old', type: 'line', dataRange: 'B2:B5', anchor: 'E2', width: 672, height: 392 }];
    assert.match(chartsFrom([{ id: 'a', anchor: 'K2' }], 't2', existing).error, /no chart "a" on this tab/);
    const legacy = chartsFrom([{ id: 'old', title: 'Trend' }], 't2', existing);
    assert.deepStrictEqual(legacy.updated.map((c) => [c.id, c.title, c.tab]), [['old', 'Trend', 't2']], 'a chart without a tab is pinned to the tab that updates it');
    assert.match(chartsFrom([{ id: 'a', anchor: 'K2' }], 't1', existing, ['a']).error, /both updated and removed/);
});

test('the summary the chat reads: size in cells (default when stored without one) and the categories', () => {
    assert.deepStrictEqual(chartSummary({ id: 'a', type: 'bar', dataRange: 'B2:B5', categoriesRange: 'A2:A5', anchor: 'E2', width: 336, height: 140 }),
        { id: 'a', type: 'bar', title: undefined, dataRange: 'B2:B5', categoriesRange: 'A2:A5', anchor: 'E2', size: { cols: 3, rows: 5 } });
    assert.deepStrictEqual(chartSummary({ id: 'b', type: 'kpi', dataRange: 'B2', anchor: 'A1' }).size, { cols: 6, rows: 14 });
});
