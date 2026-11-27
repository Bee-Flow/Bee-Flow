'use strict';
/**
 * The query-log CSV writer (csvExport.mts, core) writes out the dataEngine's two CSV rules
 * itself so the export needs no datatables module. This holds the copy equal to the
 * originals: `formulaShaped(value, 'text')` (spreadsheetFile/cells.js) and `quoteField`
 * (spreadsheetFile/formats/csv.js). Owned by the datatables module, whose files it reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { csvCell } = require('./csvExport.mts');
const { formulaShaped } = require('../../dataEngine/sources/spreadsheetFile/cells');
const { quoteField } = require('../../dataEngine/sources/spreadsheetFile/formats/csv');

const SAMPLES = [
    '', 'plain', 'a,b', 'say "hi"', 'two\nlines', 'cr\rhere', ' lead', 'trail ', '\tlead tab', 'x\t',
    '=SUM(A1)', '+1', '-5', '@cmd', '\tTAB', '\rCR', "'already", '=', 'a=b', 'é,ü', ' nbsp', 'nbsp ',
    '=cmd|\' /C calc\'!A0', '"', '""', ',', ' line', 'line ', '﻿bom',
];

test('a text cell is what formulaShaped + quoteField make of it', () => {
    for (const s of SAMPLES) {
        const expected = quoteField(formulaShaped(s, 'text') ? `'${s}` : s, ',');
        assert.equal(csvCell(s), expected, JSON.stringify(s));
    }
});

test('a number, a boolean and an empty value are quoted the same way too', () => {
    for (const v of [0, -5, 1.5, true, false]) assert.equal(csvCell(v), quoteField(String(v), ','));
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
});
