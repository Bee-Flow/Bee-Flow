/**
 * sheetOutline — what a workbook holds, without its rows: headers, types,
 * fill, min/max, and the values of category columns only.
 *
 * Run: cd server && node --test core/documents/sheetOutline.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { tabOutline } = require('./sheetOutline');
const { evaluateSheet } = require('../../shared/expr/sheet.mjs');

const SEGMENTS = ['ZZP', 'MKB', 'Particulier'];
const cells = { A1: 'Naam', B1: 'Segment', C1: 'Sinds', D1: 'Omzet', E1: 'Dubbel' };
for (let r = 2; r <= 21; r++) {
    Object.assign(cells, { [`A${r}`]: `Persoon ${r}`, [`B${r}`]: SEGMENTS[r % 3], [`C${r}`]: `20${10 + (r % 10)}-03-01`, [`D${r}`]: String(r * 10), [`E${r}`]: `=D${r}*2` });
}

test('headers, types, fill and ranges per column; categories only for category columns', () => {
    const o = tabOutline('Klanten', cells, evaluateSheet(cells));
    assert.strictEqual(o.rows, 21);
    assert.strictEqual(o.usedRange, 'A1:E21');
    const byCol = Object.fromEntries(o.columns.map((c) => [c.column, c]));
    assert.deepStrictEqual(byCol.A, { column: 'A', header: 'Naam', type: 'text', filled: 20 }, 'names are never listed');
    assert.strictEqual(byCol.B.type, 'text');
    assert.deepStrictEqual(byCol.B.categories, ['Particulier (7)', 'ZZP (7)', 'MKB (6)']);
    assert.deepStrictEqual([byCol.C.type, byCol.C.min, byCol.C.max], ['date', '2010-03-01', '2019-03-01']);
    assert.deepStrictEqual([byCol.D.type, byCol.D.min, byCol.D.max], ['number', 20, 210]);
    assert.strictEqual(byCol.E.type, 'formula');
    assert.ok(!JSON.stringify(o).includes('Persoon'), 'no row value of a name column leaks');
});

test('an empty tab', () => {
    assert.deepStrictEqual(tabOutline('Leeg', {}, {}), { name: 'Leeg', rows: 0, usedRange: null, columns: [] });
});
