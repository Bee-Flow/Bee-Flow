// @typecheck
'use strict';

/**
 * Importing a workbook as a spreadsheet document (core/documents/sheetImport.js):
 * the format of a file and the functions of a formula. The import itself reads the workbook
 * with the datatables module's spreadsheet readers and keeps the cells in its tables:
 * sheetImport.datatables.test.js.
 *
 * Run: cd server && node --test core/documents/sheetImport.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { formatOf, functionsIn } = require('./sheetImport');

test('formats come from the name, else the mime', () => {
    assert.strictEqual(formatOf('a.XLSX'), 'xlsx');
    assert.strictEqual(formatOf('a.ods'), 'ods');
    assert.strictEqual(formatOf('data', 'text/csv; charset=utf-8'), 'csv');
    assert.strictEqual(formatOf('a.pdf', 'application/pdf'), null);
});

test('functionsIn ignores text in quotes', () => {
    assert.deepStrictEqual(functionsIn('=SUM(A1:A2)+XLOOKUP(B1,"MAX(",C1)'), ['SUM', 'XLOOKUP']);
});
