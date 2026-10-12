import test from 'node:test';
import assert from 'node:assert/strict';
import { templateText, isScalarList } from './templateText.mjs';

test('nothing is empty text, never the word "null"', () => {
    assert.equal(templateText(null), '');
    assert.equal(templateText(undefined), '');
});

test('text, numbers and yes/no are written as they are', () => {
    assert.equal(templateText('Hello world'), 'Hello world');
    assert.equal(templateText(42), '42');
    assert.equal(templateText(0), '0');
    assert.equal(templateText(false), 'false');
    assert.equal(templateText(true), 'true');
});

test('a list of plain values reads as "red, green, blue"', () => {
    assert.equal(templateText(['red', 'green', 'blue']), 'red, green, blue');
    assert.equal(templateText([1, 2.5, true]), '1, 2.5, true');
});

test('empty entries are skipped and an empty list is empty text', () => {
    assert.equal(templateText(['a', null, 'b']), 'a, b');
    assert.equal(templateText([]), '');
});

test('a record reads "key: value" and a table one row per line, in the order they were written', () => {
    assert.equal(templateText({ sku: 'A1', qty: 2, price: 9.95 }), 'sku: A1, qty: 2, price: 9.95');
    assert.equal(templateText([{ sku: 'A1', qty: 2 }, { sku: 'B2', qty: 1 }]), 'sku: A1, qty: 2\nsku: B2, qty: 1');
    // Empty values are left out; a nested record sits in brackets.
    assert.equal(templateText({ name: 'Acme', note: null, address: { city: 'Utrecht' } }), 'name: Acme, address: (city: Utrecht)');
});

test("lists: 'json' keeps records and tables as JSON, in the order they were written", () => {
    assert.equal(templateText([{ sku: 'A1', qty: 2 }], { lists: 'json' }), '[{"sku":"A1","qty":2}]');
});

test('a list that holds a list or a record is not a list of plain values', () => {
    assert.equal(isScalarList([[1, 2], [3]]), false);
    assert.equal(isScalarList([{ a: 1 }]), false);
    assert.equal(isScalarList(['a', 1, null]), true);
    assert.equal(templateText([[1, 2], [3]]), '1, 2\n3');
});

test("lists: 'json' keeps a list of plain values as JSON, for slots that carry data", () => {
    assert.equal(templateText(['red', 'green'], { lists: 'json' }), '["red","green"]');
    assert.equal(templateText(null, { lists: 'json' }), '');
});
