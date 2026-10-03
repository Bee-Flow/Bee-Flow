'use strict';

/**
 * Ranges and fill semantics for the spreadsheet assistant (sheetRefs.js).
 *
 * Run: cd server && node --test core/documents/sheetAssist/sheetRefs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseRange, cellsIn, shiftFormula, fillRange } = require('./sheetRefs');

test('a range in any corner order, a single cell, and nothing outside the sheet', () => {
    assert.deepStrictEqual(parseRange('D9:b2'), { c0: 1, r0: 1, c1: 3, r1: 8 });
    assert.deepStrictEqual(parseRange('$C$4'), { c0: 2, r0: 3, c1: 2, r1: 3 });
    for (const bad of ['', 'AA1', 'A0', 'A2001', 'A1:B2:C3', 'hello', null]) assert.strictEqual(parseRange(bad), null, String(bad));
    assert.deepStrictEqual(cellsIn(parseRange('A1:B2')), ['A1', 'B1', 'A2', 'B2']);
});

test('filling shifts relative references and keeps $ anchors', () => {
    assert.strictEqual(shiftFormula('=B2*C2', 0, 3), '=B5*C5');
    assert.strictEqual(shiftFormula('=B2*$C$1', 0, 3), '=B5*$C$1');
    assert.strictEqual(shiftFormula('=$B2+B$2', 2, 2), '=$B4+D$2');
    assert.strictEqual(shiftFormula('=SUM(A1:A9)', 1, 0), '=SUM(B1:B9)');
});

test('text inside quotes and function names are never shifted', () => {
    assert.strictEqual(shiftFormula('=IF(A1>0,"see B2","")', 0, 1), '=IF(A2>0,"see B2","")');
    assert.strictEqual(shiftFormula('=CONCAT(A1,"""B2""")', 0, 1), '=CONCAT(A2,"""B2""")');
    assert.strictEqual(shiftFormula('=ROUND(A1,2)', 0, 5), '=ROUND(A6,2)');
});

test('a reference pushed off the sheet becomes #REF!, values are left alone', () => {
    assert.strictEqual(shiftFormula('=A1', -1, 0), '=#REF!');
    assert.strictEqual(shiftFormula('=Z1', 1, 0), '=#REF!');
    assert.strictEqual(shiftFormula('42', 0, 3), '42');
    assert.strictEqual(shiftFormula('=A1', 0, 0), '=A1');
});

test('fillRange writes the first cell\'s formula over the whole range', () => {
    assert.deepStrictEqual(fillRange('D2:D4', '=B2*C2'), { D2: '=B2*C2', D3: '=B3*C3', D4: '=B4*C4' });
    assert.deepStrictEqual(fillRange('B10:C10', '=SUM(B2:B9)'), { B10: '=SUM(B2:B9)', C10: '=SUM(C2:C9)' });
    assert.strictEqual(fillRange('nope', '=A1'), null);
});
