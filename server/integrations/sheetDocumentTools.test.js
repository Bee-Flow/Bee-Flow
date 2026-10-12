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

const doc = { id: 's1', userId: 'owner', name: 'Budget', docType: 'spreadsheet', settings: { sheet: { datatableId: 'dt1' } } };
const writes = [];
const cells = {
    async readSheet(owner, table) {
        assert.deepStrictEqual([owner, table], ['owner', 'dt1']);
        return { cells: { A1: '2', A2: '3', A3: '=A1*A2', B1: 'note' }, rows: 3, columns: 26 };
    },
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
