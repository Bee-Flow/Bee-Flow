/**
 * countWords / stripMarkdownLite unit tests.
 *
 * countWords must match the editor's counter (BeeEditor.jsx): the naive
 * split(/\s+/).length reads '' as 1 word, which is the off-by-one that put
 * "1 word" on empty documents in five server call sites.
 *
 * Run: node --test core/text.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { countWords, stripMarkdownLite } = require('./text');

test('countWords: empty string → 0', () => {
    assert.strictEqual(countWords(''), 0);
});

test('countWords: whitespace-only → 0', () => {
    assert.strictEqual(countWords('   '), 0);
    assert.strictEqual(countWords('\n\t '), 0);
});

test('countWords: null/undefined → 0', () => {
    assert.strictEqual(countWords(null), 0);
    assert.strictEqual(countWords(undefined), 0);
});

test('countWords: counts words across mixed whitespace', () => {
    assert.strictEqual(countWords('one two'), 2);
    assert.strictEqual(countWords('  one \n two\tthree  '), 3);
});

test('stripMarkdownLite: strips headings, quotes, emphasis, code and link syntax', () => {
    const md = '# Title\n\n> quote\n\n**bold** _em_ `code` [link](https://x.example) ![alt](img.png)';
    assert.strictEqual(stripMarkdownLite(md), 'Title quote bold em code link alt');
});

test('stripMarkdownLite: drops fenced code blocks and collapses whitespace', () => {
    const md = 'before\n\n```js\nconst x = 1;\n```\n\nafter';
    assert.strictEqual(stripMarkdownLite(md), 'before after');
});

test('stripMarkdownLite: empty/nullish input → empty string', () => {
    assert.strictEqual(stripMarkdownLite(''), '');
    assert.strictEqual(stripMarkdownLite(null), '');
});
