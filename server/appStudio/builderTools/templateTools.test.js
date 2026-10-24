// @typecheck
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shortenAtWord, compactTemplateRow } = require('./templateTools');

test('shortenAtWord cuts at a word boundary and leaves short text alone', () => {
    assert.strictEqual(shortenAtWord('short text', 240), 'short text');
    const out = shortenAtWord('alpha beta gamma delta epsilon', 18);
    assert.strictEqual(out, 'alpha beta gamma…');
    assert.strictEqual(shortenAtWord(undefined, 10), '');
});

test('a captured row reports its own screen and table counts', () => {
    const row = compactTemplateRow({ id: 'utpl_1', title: 'Starter', description: 'd', source: 'captured', version: 2, screenCount: 4, tableCount: 2 }, new Map());
    assert.deepStrictEqual([row.screens, row.tables, row.source, row.version], [4, 2, 'captured', 2]);
});

test('a built-in row takes its counts from the full definition', () => {
    const full = new Map([['b1', { id: 'b1', definition: { screens: [{}, {}] }, dataModel: { tables: [{}] } }]]);
    const row = compactTemplateRow({ id: 'b1', title: 'Built in' }, full);
    assert.deepStrictEqual([row.screens, row.tables], [2, 1]);
});
