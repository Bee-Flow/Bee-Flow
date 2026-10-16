/** Run: node --test core/automationRunner/datatableCells.test.js */
const { test } = require('node:test');
const assert = require('node:assert');
const { normaliseCell, normaliseCells } = require('./datatableCells');

const META = { fields: [
    { key: 'qty', type: 'number' }, { key: 'n', type: 'number', subtype: 'integer' },
    { key: 'done', type: 'bool' }, { key: 'due', type: 'date' }, { key: 'name', type: 'text' },
] };

test('strings become the type of their column', () => {
    assert.deepStrictEqual(
        normaliseCells(META, { qty: '5', done: 'true', due: '2026-01-02', name: 'x', n: '3' }),
        { qty: 5, done: true, due: '2026-01-02', name: 'x', n: 3 });
});

test('an empty string in a typed column is no value', () => {
    assert.strictEqual(normaliseCell(META.fields[0], ''), null);
    assert.strictEqual(normaliseCell(META.fields[2], ''), null);
});

test('a type mismatch names the column and the type, never the value', () => {
    assert.throws(() => normaliseCells(META, { qty: 'abc-secret' }), (e) => {
        assert.strictEqual(e.errorClass, 'datatable_type_mismatch');
        assert.match(e.message, /"qty"/);
        assert.match(e.message, /a number/);
        assert.doesNotMatch(e.message, /abc-secret/);
        return true;
    });
    assert.throws(() => normaliseCells(META, { done: 'maybe' }), /"done".*true or false/);
    assert.throws(() => normaliseCells(META, { due: 'tomorrow' }), /"due".*date/);
    assert.throws(() => normaliseCells(META, { n: 1.5 }), /"n".*whole number/);
});
