/**
 * collectDeck is the "very flexible" half of the presentation step: one
 * parameter that accepts every shape a routine or app can bind. One test per
 * shape, and what each yields after normalizeDeck.
 *
 * Run: node --test --test-force-exit core/documents/deckCollect.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { collectDeck, MAX_COLLECTED_SLIDES } = require('./deckCollect');
const { normalizeDeck } = require('./deckModel');

function deckOf(input, meta) {
    const { deckInput, warnings } = collectDeck(input, meta);
    const d = normalizeDeck(deckInput);
    return { title: d.title, subtitle: d.subtitle, titles: d.slides.map((s) => s.title || s.body || '?'), warnings: [...warnings, ...d.warnings] };
}

test('a markdown outline (what an ai_step writes) keeps its cover title', () => {
    const d = deckOf('# T\n\nSub\n\n## A\n- x\n## B\n- y');
    assert.strictEqual(d.title, 'T');
    assert.strictEqual(d.subtitle, 'Sub');
    assert.deepStrictEqual(d.titles, ['A', 'B']);
});

test("the step's own title and subtitle win over the outline's", () => {
    const d = deckOf('# Outline title\n\n## A', { title: 'Step title', subtitle: 'Step sub' });
    assert.strictEqual(d.title, 'Step title');
    assert.strictEqual(d.subtitle, 'Step sub');
});

test('prose without headings becomes one slide under the step title', () => {
    const d = deckOf('Just a paragraph of prose.', { title: 'P' });
    assert.deepStrictEqual(d.titles, ['P']);
});

test('a JSON deck as a string or as an object', () => {
    const deck = { title: 'J', subtitle: 'JS', slides: [{ title: 'a' }, { title: 'b' }] };
    assert.deepStrictEqual(deckOf(JSON.stringify(deck)).titles, ['a', 'b']);
    const d = deckOf(deck);
    assert.strictEqual(d.title, 'J');
    assert.strictEqual(d.subtitle, 'JS');
});

test('a list mixing slide-step outputs, inline slides, nested lists and an unresolved token', () => {
    const d = deckOf([
        { slide: { title: 's1', content: '- a' } },
        { title: 'inline', bullets: ['b'] },
        [{ slide: { title: 's2' } }, [{ slide: { title: 's3' } }]],
        '{{steps.missing.output.slide}}',
    ], { title: 'L' });
    assert.deepStrictEqual(d.titles, ['s1', 'inline', 's2', 's3', '{{steps.missing.output.slide}}']);
});

test('a loop / forEach output is unwrapped through results[].output', () => {
    const loop = {
        iterations: 2,
        results: [
            { index: 0, item: { n: 1 }, output: { slide: { title: 'r1' } } },
            { index: 1, item: { n: 2 }, output: { slide: { title: 'r2' } } },
        ],
    };
    assert.deepStrictEqual(deckOf(loop, { title: 'Loop' }).titles, ['r1', 'r2']);
    // …and a single results row on its own.
    assert.deepStrictEqual(deckOf(loop.results[0], { title: 'Row' }).titles, ['r1']);
});

test('datatable rows without slide columns still yield a slide per row', () => {
    const d = deckOf([{ name: 'Row A', amount: '5' }, { name: 'Row B', amount: '6' }], { title: 'Rows' });
    assert.deepStrictEqual(d.titles, ['Row A', 'Row B']);
});

test("an ai_step's { text } and a nested { output: { text } } are treated as the outline", () => {
    assert.strictEqual(deckOf({ text: '# From AI\n## One\n- a' }).title, 'From AI');
    assert.strictEqual(deckOf({ output: { text: '# Deep\n## Two' } }).title, 'Deep');
});

test('a slide-like object at the top level is one slide, not a wrapper', () => {
    const d = deckOf({ title: 'obj', content: '- a\n- b' }, { title: 'Outer' });
    assert.strictEqual(d.title, 'Outer');
    assert.deepStrictEqual(d.titles, ['obj']);
});

test('nothing usable is a presentation_empty error; numbers and nulls are skipped', () => {
    assert.throws(() => collectDeck([]), (e) => e.errorClass === 'presentation_empty');
    assert.throws(() => collectDeck(''), (e) => e.errorClass === 'presentation_empty');
    assert.throws(() => collectDeck([null, 42, true]), (e) => e.errorClass === 'presentation_empty');
});

test('the collection cap stops a giant binding before the deck cap even runs', () => {
    const rows = Array.from({ length: MAX_COLLECTED_SLIDES + 5 }, (_, i) => ({ title: `s${i}` }));
    assert.throws(() => collectDeck(rows), (e) => e.errorClass === 'presentation_too_many_slides');
});
