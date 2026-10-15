'use strict';

/**
 * The chat's document tools on a spreadsheet (integrations/sheetDocumentTools.js):
 * a read answers with the cells and what each formula computes; a write takes
 * `cells`; read-only and malformed calls are explained to the model.
 *
 * Run: cd server && node --test integrations/sheetDocumentTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { HttpError } = require('../core/http/errors');
const { readSheetDocument, writeSheetDocument, SHEET_EDIT_REFUSAL } = require('./sheetDocumentTools');
const { evaluateSheet } = require('../shared/expr/sheet.mjs');

const doc = { id: 's1', userId: 'owner', name: 'Budget', docType: 'spreadsheet', settings: { sheet: { tabs: [{ id: 't1', name: 'Main', datatableId: 'dt1' }, { id: 't2', name: 'Totals', datatableId: 'dt2' }] } } };
const oldDoc = { ...doc, settings: { sheet: { datatableId: 'dt1' } } };
const writes = [];
const cells = {
    async readSheet(owner, table) {
        assert.strictEqual(owner, 'owner');
        if (table === 'dt2') return { cells: { A1: 'x' }, rows: 1, columns: 26 };
        assert.strictEqual(table, 'dt1');
        return { cells: { A1: '2', A2: '3', A3: '=A1*A2', B1: 'note' }, rows: 3, columns: 26 };
    },
    created: [],
    dropped: [],
    async createSheetTable({ ownerUserId, name }) { cells.created.push([ownerUserId, name]); return { id: `dt-new-${cells.created.length}` }; },
    async dropSheetTable(owner, table) { cells.dropped.push([owner, table]); },
    async writeCells(owner, table, c) {
        if (c.AA1 !== undefined) throw new HttpError(400, 'sheet_cell_out_of_range', '"AA1" is not a cell of this sheet.');
        writes.push([owner, table, c]);
        return { cells: c };
    },
};

test('a read gives the typed cells and what every formula shows', async () => {
    const out = await readSheetDocument(doc, { cells, evaluate: evaluateSheet });
    assert.deepStrictEqual(out.cells, { A1: '2', A2: '3', A3: '=A1*A2', B1: 'note' });
    assert.deepStrictEqual(out.computed, { A3: '6' });
    assert.strictEqual(out.rows, 3);
    assert.match(out.message, /document_write\(\{ documentId, cells/);
    const viewer = await readSheetDocument({ ...doc, projectRole: 'viewer' }, { cells, evaluate: evaluateSheet });
    assert.strictEqual(viewer.readOnly, true);
    assert.doesNotMatch(viewer.message, /document_write/);
});

test('a write takes cells, as text, as the owner', async () => {
    writes.length = 0;
    const out = await writeSheetDocument(doc, { cells: { B2: 12, C3: null, D4: '=SUM(A1:A3)' } }, { cells });
    assert.strictEqual(out.saved, 3);
    assert.deepStrictEqual(writes, [['owner', 'dt1', { B2: '12', C3: '', D4: '=SUM(A1:A3)' }]]);
});

test('a write without cells, or one the sheet refuses, is explained', async () => {
    assert.match((await writeSheetDocument(doc, { bodyHtml: '<p>x</p>' }, { cells })).error, /spreadsheet: it has no bodyHtml/);
    assert.match((await writeSheetDocument(doc, { cells: { AA1: 'x' } }, { cells })).error, /not a cell/);
    assert.match(SHEET_EDIT_REFUSAL.error, /spreadsheet/);
});

test('a read names the tab and lists the tabs; another tab by name or id', async () => {
    const first = await readSheetDocument(doc, { cells, evaluate: evaluateSheet });
    assert.deepStrictEqual(first.tab, { id: 't1', name: 'Main' });
    assert.deepStrictEqual(first.tabs, [{ id: 't1', name: 'Main' }, { id: 't2', name: 'Totals' }]);
    const byName = await readSheetDocument(doc, { cells, evaluate: evaluateSheet }, { tab: 'totals' });
    assert.deepStrictEqual(byName.cells, { A1: 'x' });
    const byId = await readSheetDocument(doc, { cells, evaluate: evaluateSheet }, { tab: 't2' });
    assert.strictEqual(byId.tab.name, 'Totals');
    assert.match((await readSheetDocument(doc, { cells, evaluate: evaluateSheet }, { tab: 'nope' })).error, /no tab "nope"/);
});

test('the old { datatableId } shape is one tab', async () => {
    writes.length = 0;
    const out = await readSheetDocument(oldDoc, { cells, evaluate: evaluateSheet });
    assert.strictEqual(out.tab.name, 'Sheet1');
    await writeSheetDocument(oldDoc, { cells: { A1: '1' } }, { cells });
    assert.strictEqual(writes[0][1], 'dt1');
});

test('a write goes to the chosen tab, in chunks of 500, with a total cap', async () => {
    writes.length = 0;
    const many = {};
    for (let i = 1; i <= 1200; i += 1) many[`A${i}`] = String(i);
    const out = await writeSheetDocument(doc, { tab: 'Totals', cells: many }, { cells });
    assert.strictEqual(out.saved, 1200);
    assert.deepStrictEqual(writes.map((w) => [w[1], Object.keys(w[2]).length]), [['dt2', 500], ['dt2', 500], ['dt2', 200]]);
    const huge = {};
    for (let i = 0; i < 5001; i += 1) huge[`A${i + 1}`] = 'x';
    assert.match((await writeSheetDocument(doc, { cells: huge }, { cells })).error, /At most 5000/);
    assert.match((await writeSheetDocument(doc, { tab: 'zzz', cells: { A1: '1' } }, { cells })).error, /no tab/);
});

test('createTab adds the named tab, then writes there; without it an unknown tab is explained', async () => {
    writes.length = 0; cells.created.length = 0; cells.dropped.length = 0;
    const updates = [];
    const documents = { async updateDocument(id, actor, u) { updates.push([id, actor, u]); return { id }; } };
    const refused = await writeSheetDocument(doc, { tab: 'Draaitabel', cells: { A1: 'x' } }, { cells, documents });
    assert.match(refused.error, /no tab "Draaitabel".*createTab: true/);
    assert.strictEqual(updates.length, 0);

    const out = await writeSheetDocument({ ...doc, versionId: 'v7' }, { tab: 'Draaitabel', createTab: true, cells: { A1: 'Segment', B2: '=COUNTIF(Main!$A$1:$A$3,A2)' } }, { cells, documents, actorUserId: 'editor' });
    assert.strictEqual(out.createdTab, true);
    assert.strictEqual(out.tab.name, 'Draaitabel');
    assert.deepStrictEqual(out.tabs.map((t) => t.name), ['Main', 'Totals', 'Draaitabel']);
    assert.deepStrictEqual(cells.created, [['owner', 'Draaitabel']]);
    const [id, actor, u] = updates[0];
    assert.strictEqual(id, 's1');
    assert.strictEqual(actor, 'editor');
    assert.strictEqual(u.expectedVersionId, 'v7');
    assert.deepStrictEqual(u.settings.sheet.tabs.map((t) => t.datatableId), ['dt1', 'dt2', 'dt-new-1']);
    assert.deepStrictEqual(writes, [['owner', 'dt-new-1', { A1: 'Segment', B2: '=COUNTIF(Main!$A$1:$A$3,A2)' }]]);
});

test('a refused new tab drops its table and comes back as text', async () => {
    cells.created.length = 0; cells.dropped.length = 0;
    const documents = { async updateDocument() { throw new HttpError(403, 'document_owner_only', 'Only the owner can change this.'); } };
    const out = await writeSheetDocument(doc, { tab: 'X', createTab: true, cells: { A1: '1' } }, { cells, documents });
    assert.match(out.error, /Only the owner/);
    assert.deepStrictEqual(cells.dropped, [['owner', 'dt-new-1']]);
});

test('a read of a tab whose formulas point at another tab computes them over that tab', async () => {
    const book = { ...doc, settings: { sheet: { tabs: [{ id: 't1', name: 'Main', datatableId: 'dt1' }, { id: 't3', name: 'Pivot', datatableId: 'dt3' }] } } };
    const twoTabs = {
        async readSheet(_owner, table) {
            if (table === 'dt3') return { cells: { A1: '=SUM(Main!A1:A2)', A2: '=COUNTIF(Main!$A$1:$A$2,"3")' }, rows: 2, columns: 26 };
            return { cells: { A1: '2', A2: '3' }, rows: 2, columns: 26 };
        },
    };
    const out = await readSheetDocument(book, { cells: twoTabs, evaluate: evaluateSheet }, { tab: 'Pivot' });
    assert.deepStrictEqual(out.computed, { A1: '5', A2: '1' });
});

test('mode "outline" answers every tab\'s columns and no rows', async () => {
    const out = await readSheetDocument(doc, { cells, evaluate: evaluateSheet }, { mode: 'outline' });
    assert.deepStrictEqual(out.outline.map((t) => t.name), ['Main', 'Totals']);
    assert.strictEqual(out.cells, undefined);
    assert.strictEqual(out.outline[0].usedRange, 'A1:B3');
});

test('`range` reads part of a tab; a large tab without one comes as its first rows', async () => {
    const part = await readSheetDocument(doc, { cells, evaluate: evaluateSheet }, { range: 'A2:A3' });
    assert.deepStrictEqual(part.cells, { A2: '3', A3: '=A1*A2' });
    assert.deepStrictEqual(part.computed, { A3: '6' });
    assert.match((await readSheetDocument(doc, { cells, evaluate: evaluateSheet }, { range: 'A1:AA9' })).error, /not a range/);

    const big = {};
    for (let r = 1; r <= 100; r++) for (const c of 'ABCDEFGHIJKLMNOP') big[`${c}${r}`] = String(r);
    const large = await readSheetDocument(doc, { cells: { async readSheet() { return { cells: big, rows: 100, columns: 26 }; } }, evaluate: evaluateSheet });
    assert.strictEqual(Object.keys(large.cells).length, 30 * 16);
    assert.match(large.message, /only rows 1–30 are included/);
});

test('`charts` puts charts in the sheet, on the tab written to; cells may be left out', async () => {
    const updates = [];
    const documents = {
        async getDocument() { return { ...doc, versionId: 'v2' }; },
        async updateDocument(id, actor, u) { updates.push(u); return { id }; },
    };
    const out = await writeSheetDocument(doc, { tab: 'Totals', charts: [{ type: 'bar', dataRange: 'B2:B5', categoriesRange: 'A2:A5', anchor: 'D2' }] }, { cells, documents, actorUserId: 'editor' });
    assert.strictEqual(out.charts, 1, JSON.stringify(out));
    assert.match(out.message, /1 chart\(s\)/);
    assert.deepStrictEqual(updates[0].settings.sheet.charts.map((c) => [c.type, c.tab]), [['bar', 't2']]);
    assert.match((await writeSheetDocument(doc, { charts: [{ type: 'radar', dataRange: 'B2:B5', anchor: 'D2' }] }, { cells, documents })).error, /type must be one of/);
});

test('reads list the tab\'s charts; a write can update a chart by id and remove others', async () => {
    const charted = { ...doc, settings: { sheet: { ...doc.settings.sheet, charts: [
        { id: 'k1', type: 'bar', title: 'Sales', dataRange: 'B2:B5', anchor: 'D2', width: 672, height: 392, tab: 't1' },
        { id: 'k2', type: 'pie', dataRange: 'B2:B5', anchor: 'D20', width: 336, height: 280, tab: 't2' },
    ] } } };
    const read = await readSheetDocument(charted, { cells, evaluate: evaluateSheet });
    assert.deepStrictEqual(read.charts, [{ id: 'k1', type: 'bar', title: 'Sales', dataRange: 'B2:B5', anchor: 'D2', size: { cols: 6, rows: 14 } }]);
    const outline = await readSheetDocument(charted, { cells, evaluate: evaluateSheet }, { mode: 'outline' });
    assert.deepStrictEqual(outline.outline.map((t) => t.charts.map((c) => c.id)), [['k1'], ['k2']]);
    const updates = [];
    const documents = {
        async getDocument() { return { ...charted, versionId: 'v2' }; },
        async updateDocument(id, actor, u) { updates.push(u); return { id }; },
    };
    const out = await writeSheetDocument(charted, { tab: 'Main', charts: [{ id: 'k1', anchor: 'H2', type: 'hbar' }], removeCharts: [] }, { cells, documents });
    assert.strictEqual(out.chartsUpdated, 1, JSON.stringify(out));
    assert.deepStrictEqual(updates[0].settings.sheet.charts.map((c) => [c.id, c.type, c.anchor]), [['k1', 'hbar', 'H2'], ['k2', 'pie', 'D20']]);
    const gone = await writeSheetDocument(charted, { tab: 'Totals', removeCharts: ['k2'] }, { cells, documents });
    assert.strictEqual(gone.chartsRemoved, 1);
    assert.deepStrictEqual(updates[1].settings.sheet.charts.map((c) => c.id), ['k1']);
});
