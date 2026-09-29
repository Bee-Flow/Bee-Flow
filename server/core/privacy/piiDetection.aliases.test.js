/**
 * One entity, one token.
 *
 * The token key used to be the EXACT string per category, so a single pasted
 * meeting transcript produced 20 [organization_N] tokens for about 8 companies,
 * and gave "Tom" and "Tom Smit" separate person tokens. Two costs: the model
 * cannot tell that [person_4] and [person_3] are the same human (so it reasons
 * badly about who did what), and the user is shown a mapping table that looks
 * broken.
 *
 * Two coalescing rules, both deliberately conservative:
 *   1. spelling variants — same value once case, punctuation and whitespace go;
 *   2. name parts — a value whose words are a proper subset of a longer value's
 *      words, UNLESS it fits more than one (two different Toms must stay two
 *      people).
 *
 * Explicitly NOT fuzzy: "24x7 ICT"/"24-7 ICT" and "Beeflow"/"Bflow" need
 * edit-distance matching, which is a different and riskier problem.
 *
 * Run: node --test server/core/piiDetection.aliases.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}
stub('../aiAgent', { getAIConfig: async () => ({}) });
stub('../../stores/configStore', {
    getConfig: async () => null, getSecret: async () => '', getAllConfig: async () => ({}),
});

const { tokenizeText } = require('./piiDetection');

/** Build entity records for every occurrence of each (value, category) pair. */
function spans(text, pairs) {
    const out = [];
    for (const [value, category] of pairs) {
        let from = 0;
        for (;;) {
            const idx = text.indexOf(value, from);
            if (idx === -1) break;
            out.push({ text: value, category, offset: idx, length: value.length, confidence: 0.9 });
            from = idx + value.length;
        }
    }
    return out;
}

test('a first name folds into the full name it belongs to', () => {
    const text = 'Tom Smit opende de call. Tom vroeg om de cijfers.';
    const { tokenizedText, tokenMap } = tokenizeText(text, spans(text, [['Tom Smit', 'Person'], ['Tom', 'Person']]));

    assert.strictEqual(Object.keys(tokenMap).length, 1, `expected one person token, got ${JSON.stringify(tokenMap)}`);
    assert.strictEqual(tokenMap['[person_1]'], 'Tom Smit', 'the canonical value is the full form');
    assert.strictEqual(tokenizedText, '[person_1] opende de call. [person_1] vroeg om de cijfers.');
});

test('a surname folds into the full name too', () => {
    const text = 'Theodorus van der Brug belde. Brug was kort van stof.';
    const { tokenMap } = tokenizeText(text, spans(text, [['Theodorus van der Brug', 'Person'], ['Brug', 'Person']]));
    assert.deepStrictEqual(tokenMap, { '[person_1]': 'Theodorus van der Brug' });
});

test('two different people sharing a first name keep separate tokens', () => {
    // The ambiguity guard. Merging here would tell the model that one person
    // did both things.
    const text = 'Tom Smit en Tom Jansen zaten er allebei bij. Tom nam het woord.';
    const { tokenMap } = tokenizeText(text, spans(text, [
        ['Tom Smit', 'Person'], ['Tom Jansen', 'Person'], ['Tom', 'Person'],
    ]));
    const values = Object.values(tokenMap).sort();
    assert.deepStrictEqual(values, ['Tom', 'Tom Jansen', 'Tom Smit']);
});

test('spelling variants of an organisation share one token', () => {
    const text = 'Beheer IT regelt het. beheer-it heeft de ticketrij. BEHEER IT reageert snel.';
    const { tokenMap } = tokenizeText(text, spans(text, [
        ['Beheer IT', 'Organization'], ['beheer-it', 'Organization'], ['BEHEER IT', 'Organization'],
    ]));
    assert.strictEqual(Object.keys(tokenMap).length, 1, JSON.stringify(tokenMap));
    assert.strictEqual(tokenMap['[organization_1]'], 'Beheer IT');
});

test('a bare particle never folds into a name', () => {
    // "van der" has no distinctive word, so it must not become Theodorus.
    const text = 'Theodorus van der Brug. Ook van der stond erbij.';
    const { tokenMap } = tokenizeText(text, spans(text, [
        ['Theodorus van der Brug', 'Person'], ['van der', 'Person'],
    ]));
    const values = Object.values(tokenMap).sort();
    assert.deepStrictEqual(values, ['Theodorus van der Brug', 'van der']);
});

test('numeric categories are never coalesced by name parts', () => {
    // Subsumption is Person/Organization only: two phone numbers that share a
    // prefix are two different numbers.
    const text = 'Bel 0612345678 of anders 06123456.';
    const { tokenMap } = tokenizeText(text, spans(text, [
        ['0612345678', 'PhoneNumber'], ['06123456', 'PhoneNumber'],
    ]));
    assert.strictEqual(Object.keys(tokenMap).length, 2, JSON.stringify(tokenMap));
});

test('a later turn upgrades the token to the fuller form and keeps its number', () => {
    // Turn 1 saw only "Tom"; turn 2 sees the full name. The token must stay
    // [person_1] — a new number would leave the model with two people.
    const existing = { '[person_1]': 'Tom', '[email_1]': 'tom@voorbeeld.nl' };
    const text = 'Tom Smit stuurde het door.';
    const { tokenizedText, tokenMap } = tokenizeText(text, spans(text, [['Tom Smit', 'Person']]), existing);

    assert.strictEqual(tokenizedText, '[person_1] stuurde het door.');
    assert.strictEqual(tokenMap['[person_1]'], 'Tom Smit');
});

test('unrelated values in the same category still get their own tokens', () => {
    const text = 'Capgemini en Intellistore werken samen met PostNL.';
    const { tokenMap } = tokenizeText(text, spans(text, [
        ['Capgemini', 'Organization'], ['Intellistore', 'Organization'], ['PostNL', 'Organization'],
    ]));
    assert.strictEqual(Object.keys(tokenMap).length, 3, JSON.stringify(tokenMap));
});
