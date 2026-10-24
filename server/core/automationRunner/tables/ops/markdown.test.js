// @typecheck
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toMarkdown } = require('./markdown');

test('toMarkdown writes header, separator and rows, escaping pipes and line breaks', () => {
    const md = toMarkdown([{ key: 'a', label: 'A | label' }, { key: 'b' }], [{ a: 'x|y', b: 'one\ntwo' }, { a: null, b: 3 }]);
    assert.equal(md, ['| A \\| label | b |', '| --- | --- |', '| x\\|y | one two |', '|  | 3 |'].join('\n'));
});

test('toMarkdown cuts long cells', () => {
    const md = toMarkdown([{ key: 'a' }], [{ a: 'x'.repeat(50) }], { maxCellChars: 10 });
    assert.match(md.split('\n')[2], /^\| x{9}… \|$/);
});

test('toMarkdown of no columns is empty', () => {
    assert.equal(toMarkdown([], []), '');
});
