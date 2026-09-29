'use strict';

/**
 * `sweepNameOccurrences` — which further mentions of an already-found person
 * the tokenizer replaces (BFSF-269, BFSF-300). The token each one gets is the
 * alias index's business and is pinned in tokenizer.test.js; this file pins
 * WHICH text is swept and, just as important, which is left alone.
 *
 * All names and addresses are synthetic.
 *
 * Run: cd server && node --test core/privacy/piiDetection/nameSweep.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { sweepNameOccurrences } = require('./nameSweep');

const PARTICLES = new Set(['van', 'de', 'der', 'den', 'ten', 'ter', 'te']);
const categoryKeyOf = (s) => String(s.category || '').toLowerCase();

/** A detected span for the first occurrence of `value` at or after `from`. */
function span(text, value, category = 'Person', from = 0) {
    const offset = text.indexOf(value, from);
    assert.ok(offset >= 0, `fixture: "${value}" not in text`);
    return { text: value, category, label: category === 'Person' ? 'Person Name' : category, offset, length: value.length };
}

function sweep(text, spans, seedEntries = []) {
    return sweepNameOccurrences({ text, spans, seedEntries, categoryKeyOf, particles: PARTICLES });
}

const sweptTexts = (out) => out.map(e => e.text);

test('every further mention of a found name is returned, with its offset in the text', () => {
    const text = 'Hendrik Vos belde. Later schreef Hendrik Vos nog, en Vos tekende.';
    const out = sweep(text, [span(text, 'Hendrik Vos')]);

    for (const e of out) assert.strictEqual(text.slice(e.offset, e.offset + e.length), e.text);
    assert.deepStrictEqual(sweptTexts(out).sort(), ['Hendrik Vos', 'Vos']);
    assert.ok(out.every(e => e.category === 'Person' && e.label === 'Person Name' && e.swept === true));
});

test('a full name is swept whole, not word by word', () => {
    const text = 'Iris Hoekstra opende. Iris Hoekstra sloot af.';
    const out = sweep(text, [span(text, 'Iris Hoekstra')]);
    assert.deepStrictEqual(sweptTexts(out), ['Iris Hoekstra'],
        'the second full name must be one span, or it becomes one token per word');
});

test('nothing already covered by a detected span is swept again', () => {
    const text = 'Iris Hoekstra mailde iris.hoekstra@example.test over Iris.';
    const out = sweep(text, [
        span(text, 'Iris Hoekstra'),
        span(text, 'iris.hoekstra@example.test', 'Email'),
    ]);
    assert.deepStrictEqual(sweptTexts(out), ['Iris'], 'only the bare first name was still uncovered');
});

test('matches are word-bounded and case-sensitive', () => {
    const text = 'Anna Bakker kwam langs. Annabel en de bakker aan de Bakkerstraat bleven weg.';
    const out = sweep(text, [span(text, 'Anna Bakker')]);
    assert.deepStrictEqual(out, [],
        'a longer word that starts with the name, or the lower-case noun, is not the person');
});

test('letters with diacritics count as word characters for the boundary', () => {
    const text = 'Zoë Brouwer belde. Zoëlla en Zoë bleven.';
    const out = sweep(text, [span(text, 'Zoë Brouwer')]);
    assert.deepStrictEqual(sweptTexts(out), ['Zoë']);
    assert.strictEqual(out[0].offset, text.lastIndexOf('Zoë'));
});

test('particles and titles are never swept on their own', () => {
    const text = 'Drs. Ruben van Leeuwen opende. Drs. en ingenieurs van de afdeling; Leeuwen sloot af.';
    const out = sweep(text, [span(text, 'Drs. Ruben van Leeuwen')]);
    assert.deepStrictEqual(sweptTexts(out), ['Leeuwen'],
        '"Drs" and "van" identify nobody and must stay plain text');
});

test('a value without a distinctive word sweeps nothing', () => {
    const text = 'van der kwam. Later weer van der.';
    assert.deepStrictEqual(sweep(text, [span(text, 'van der')]), []);
});

test('a first name that is also a common word is left alone at the start of a sentence', () => {
    // "Will" opens a question here; the lower-case "will" elsewhere shows the
    // word is in ordinary use in this text.
    const text = 'Will Hartman sent the draft. Will you check it today? I will reply. Thanks, Will.';
    const out = sweep(text, [span(text, 'Will Hartman')]);
    assert.deepStrictEqual(sweptTexts(out), ['Will'], 'only the sign-off is the person');
    assert.strictEqual(out[0].offset, text.lastIndexOf('Will'));
});

test('a name at the start of a sentence is swept when the word has no lower-case use', () => {
    const text = 'Hendrik Vos opende de call. Hendrik vroeg om de cijfers.\nHendrik';
    const out = sweep(text, [span(text, 'Hendrik Vos')]);
    assert.deepStrictEqual(sweptTexts(out), ['Hendrik', 'Hendrik']);
});

test('names from the conversation map are swept too, with the Person category', () => {
    const text = 'Stuur het naar daan@example.test, Daan wacht erop.';
    const out = sweep(text, [span(text, 'daan@example.test', 'Email')], [
        ['[person_1]', 'Daan Verbeek'],
        ['[email_1]', 'other@example.test'],
    ]);
    assert.deepStrictEqual(out.map(e => [e.text, e.category, e.label]), [['Daan', 'Person', 'Person Name']]);
});

test('a lower-case name part is not evidence for every lower-case word', () => {
    const text = 'daan verbeek belde; daan is een woord hier.';
    const out = sweep(text, [span(text, 'daan verbeek')]);
    assert.deepStrictEqual(out, [], 'one-word needles must be written capitalised');
});

test('a value across table cells is swept by its parts, never as a cross-cell span', () => {
    const text = 'Van Leeuwen, Ruben\nRuben\nvan\nLeeuwen';
    const out = sweep(text, [span(text, 'Ruben\nvan\nLeeuwen')]);
    assert.deepStrictEqual(sweptTexts(out).sort(), ['Leeuwen', 'Ruben']);
    assert.ok(out.every(e => !/[\n\t]/.test(e.text)));
});

test('other categories are not swept', () => {
    const text = 'Mail a@example.test en nogmaals a@example.test.';
    assert.deepStrictEqual(sweep(text, [span(text, 'a@example.test', 'Email')]), []);
});

test('reserved ranges are never swept, and name nobody', () => {
    // A caller that replaces these ranges itself afterwards (a blocked
    // tool-result value) needs them whole: a token on part of one would stop
    // its literal replacement and leave the rest in plain text.
    const text = 'Hendrik Vos belde. Hendrik de Vries mailde, Hendrik ook.';
    const blocked = 'Hendrik de Vries';
    const out = sweepNameOccurrences({
        text, spans: [span(text, 'Hendrik Vos')], categoryKeyOf, particles: PARTICLES,
        reserved: [{ offset: text.indexOf(blocked), length: blocked.length }],
    });
    assert.deepStrictEqual(out.map(e => [e.text, e.offset]), [['Hendrik', text.lastIndexOf('Hendrik')]]);
});
