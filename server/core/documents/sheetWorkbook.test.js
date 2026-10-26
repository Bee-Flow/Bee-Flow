// @typecheck strict
/**
 * sheetWorkbook — only the tabs a formula names are read, keyed by tab name,
 * so the editor and the chat compute `Klanten!A1` instead of #REF!.
 *
 * Run: cd server && node --test core/documents/sheetWorkbook.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { referencedTabs, readReferencedTabs } = require('./sheetWorkbook');
const { evaluateSheet } = require('../../shared/expr/sheet.mjs');

const TABS = [
    { id: 't1', name: 'Klanten', datatableId: 'dt1' },
    { id: 't2', name: 'Omzet', datatableId: 'dt2' },
    { id: 't3', name: 'Draaitabel', datatableId: 'dt3' },
];
const PIVOT = { A1: 'ZZP', B1: '=COUNTIF(Klanten!$L$2:$L$4,A1)', C1: 'Klanten!A1 as text', D1: '=B1*2' };

test('a formula names the tabs it needs; text and the active tab do not count', () => {
    assert.deepStrictEqual(referencedTabs(PIVOT, TABS, 't3').map((t) => t.name), ['Klanten']);
    assert.deepStrictEqual(referencedTabs({ A1: '=Draaitabel!A1' }, TABS, 't3'), []);
    assert.deepStrictEqual(referencedTabs({ A1: '=Nope!A1' }, TABS, 't3'), []);
});

test('reads those tabs once each, and the engine computes over them', async () => {
    /** @type {unknown[][]} */
    const reads = [];
    const sheetCells = { async readSheet(/** @type {string} */ owner, /** @type {string} */ table) { reads.push([owner, table]); return { cells: { L2: 'ZZP', L3: 'MKB', L4: 'ZZP' } }; } };
    const refTabs = await readReferencedTabs({ userId: 'u1' }, TABS, 't3', PIVOT, sheetCells);
    assert.deepStrictEqual(reads, [['u1', 'dt1']]);
    const shown = evaluateSheet(PIVOT, { workbook: { ...refTabs, Draaitabel: PIVOT }, activeSheet: 'Draaitabel' });
    assert.strictEqual(shown.B1.display, '2');
    assert.strictEqual(shown.D1.display, '4');
});
