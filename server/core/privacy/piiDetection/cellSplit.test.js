const test = require('node:test');
const assert = require('node:assert/strict');
const { splitAtCellBreaks, isFragment } = require('./cellSplit');
const { tokenizeText } = require('./tokenizer');

const P = new Set(['van', 'de', 'der', 'ter', 't', 's']);
const span = (text, value, category) => ({ offset: text.indexOf(value), length: value.length, category, text: value });

test('a span over three cells becomes one span per cell (BFSF-299; values fictional)', () => {
    const text = 'Dorpsstraat 4\n1234 AB\nUtrecht';
    const out = splitAtCellBreaks([span(text, text, 'Address')], text, { particles: P });
    assert.deepEqual(out.map(e => e.text), ['Dorpsstraat 4', '1234 AB', 'Utrecht']);
    for (const e of out) assert.equal(text.slice(e.offset, e.offset + e.length), e.text);
});

test('tab and table-pipe are breaks too; whitespace around a piece is trimmed', () => {
    const text = '| Jan Jansen | Pieter Smit |';
    const out = splitAtCellBreaks([span(text, 'Jan Jansen | Pieter Smit', 'Person')], text, { particles: P });
    assert.deepEqual(out.map(e => e.text), ['Jan Jansen', 'Pieter Smit']);
    const tsv = 'Jan\tJansen';
    assert.deepEqual(splitAtCellBreaks([span(tsv, tsv, 'Person')], tsv, { particles: P }).map(e => e.text), ['Jan', 'Jansen']);
});

test('a piece that is no value of its own is dropped: a particle cell, a short number', () => {
    assert.equal(isFragment('Person', "van 't", P), true);
    assert.equal(isFragment('Person', 'Li', P), false);
    assert.equal(isFragment('Address', '7', P), true);
    assert.equal(isFragment('Phone', '0612345678', P), false);
    const text = 'Jan\nter\nHorst';
    assert.deepEqual(splitAtCellBreaks([span(text, text, 'Person')], text, { particles: P }).map(e => e.text), ['Jan', 'Horst']);
});

test('a span inside one cell is left exactly as it was', () => {
    const text = 'Mail Jan Jansen today';
    const e = span(text, 'Jan Jansen', 'Person');
    assert.equal(splitAtCellBreaks([e], text, { particles: P })[0], e);
});

test('tokenizeText keeps the row shape: one token per cell, the newlines stay', () => {
    const text = 'Dorpsstraat 4\n1234 AB\nUtrecht';
    const { tokenizedText, tokenMap } = tokenizeText(text, [span(text, text, 'Address')]);
    assert.equal((tokenizedText.match(/\n/g) || []).length, 2);
    assert.equal(Object.keys(tokenMap).length, 3);
});
