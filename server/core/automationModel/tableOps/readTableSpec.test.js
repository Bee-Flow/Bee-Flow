'use strict';
/** The read_table step's settings: defaults, clamping and the findings of a bad one. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReadTableStep, validateReadTableStep } = require('./readTableSpec');

const ref = { kind: 'ref', path: 'trigger.output.upload' };
const codes = (step) => validateReadTableStep(step).map(f => f.code);

test('normalize fills every default', () => {
    assert.deepEqual(normalizeReadTableStep({ type: 'read_table', source: ref }), {
        source: ref, sheets: 'all', headerRow: 1, provenanceSheet: 'auto', format: 'auto', delimiter: 'auto',
        skipHiddenSheets: true, expiresInDays: 7,
    });
    assert.equal(normalizeReadTableStep(null).source, null);
});

test('normalize clamps and replaces what is out of range', () => {
    const n = normalizeReadTableStep({
        source: ref, headerRow: 99, expiresInDays: 400, format: 'pdf', delimiter: 'x', sheets: [], skipHiddenSheets: false,
    });
    assert.equal(n.headerRow, 50);
    assert.equal(n.expiresInDays, 90);
    assert.equal(n.format, 'auto');
    assert.equal(n.delimiter, 'auto');
    assert.equal(n.sheets, 'all');
    assert.equal(n.skipHiddenSheets, false);
    assert.equal(normalizeReadTableStep({ headerRow: 0 }).headerRow, 1);
    assert.equal(normalizeReadTableStep({ headerRow: '3' }).headerRow, 3);
    assert.deepEqual(normalizeReadTableStep({ sheets: ['A', '', 7, 'B'] }).sheets, ['A', 'B']);
});

test('the tab delimiter may be written as a tab, "tab" or \\t', () => {
    for (const d of ['\t', 'tab', '\\t']) assert.equal(normalizeReadTableStep({ delimiter: d }).delimiter, '\t');
    assert.deepEqual(codes({ source: ref, delimiter: 'tab' }), []);
});

test('a valid step has no findings', () => {
    assert.deepEqual(validateReadTableStep({
        source: ref, sheets: ['Data'], headerRow: 2, provenanceSheet: 'Notes', format: 'xlsx', delimiter: ';', expiresInDays: 30,
    }), []);
    assert.deepEqual(validateReadTableStep({ source: { kind: 'literal', value: { kind: 'form_upload', fileId: 'f1' } } }), []);
});

test('a missing source is an error, a fixed value is a warning', () => {
    for (const source of [undefined, null, '', { kind: 'ref', path: ' ' }, { kind: 'template', value: '' }, { kind: 'literal', value: '' }]) {
        const [f] = validateReadTableStep({ source });
        assert.equal(f.code, 'read_table.source_missing', JSON.stringify(source));
        assert.equal(f.severity, 'error');
        assert.equal(f.path, 'source');
    }
    const [lit] = validateReadTableStep({ source: { kind: 'literal', value: 'a.xlsx' } });
    assert.equal(lit.code, 'read_table.source_literal');
    assert.equal(lit.severity, 'warning');
    assert.match(lit.hint, /form file answer or to a generated file/);
    assert.equal(validateReadTableStep({ source: 'a.xlsx' })[0].code, 'read_table.source_literal');
});

test('every invalid setting has its own code and path', () => {
    const f = validateReadTableStep({
        source: ref, headerRow: 0, sheets: [1], format: 'pdf', delimiter: 'x', expiresInDays: 91,
    });
    assert.deepEqual(f.map(x => [x.code, x.path]), [
        ['read_table.header_row_invalid', 'headerRow'],
        ['read_table.sheets_invalid', 'sheets'],
        ['read_table.format_invalid', 'format'],
        ['read_table.delimiter_invalid', 'delimiter'],
        ['read_table.expires_invalid', 'expiresInDays'],
    ]);
    assert.ok(f.every(x => x.severity === 'error'));
    assert.deepEqual(codes({ source: ref, headerRow: 1.5 }), ['read_table.header_row_invalid']);
    assert.deepEqual(codes({ source: ref, headerRow: 'abc' }), ['read_table.header_row_invalid']);
    assert.deepEqual(codes({ source: ref, sheets: 'second' }), ['read_table.sheets_invalid']);
    assert.deepEqual(codes({ source: ref, sheets: [] }), ['read_table.sheets_invalid']);
});
