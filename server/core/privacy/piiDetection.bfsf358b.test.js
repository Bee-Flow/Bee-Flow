/**
 * BFSF-358B regression: the Privacy Shield must not rewrite what a user typed.
 *
 * The report: an automation's Gmail step searched for a first name and Google
 * received the longest full name the run had seen (here, fictionally, "Ruben"
 * became "van Ruben van de Laar") — zero results, while the query as typed
 * does find mail.
 *
 * The mechanism: the automation runner tokenizes EVERY string leaf of a step's
 * inputs and restores them from the run vault, and tokenizeText's alias
 * coalescing (rule 2 — "Tom" ⊂ "Tom Smit") folds a short person name into the
 * LONGEST variant seen earlier in the run. Rule 1 does the same to spelling and
 * casing. Coalescing is right for prose — the model must be able to tell that
 * [person_3] and [person_4] are one human — but a search box is not prose: the
 * whole input IS one literal value, and expanding it changes its meaning.
 *
 * The rule pinned here: when the detected span IS the whole scanned text, the
 * token's stored value is that text VERBATIM, so tokenize → restore is
 * byte-identical. Everything else about coalescing is unchanged — see
 * piiDetection.aliases.test.js, which still passes in full.
 *
 * Run: cd server && node --test core/piiDetection.bfsf358b.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../aiAgent', { getAIConfig: async () => ({}) });
stub('../../stores/configStore', {
    getConfig: async () => null, getSecret: async () => '', getAllConfig: async () => ({}),
});

const { tokenizeText, restoreTokens } = require('./piiDetection');

const span = (text, value, category = 'Person') => ({
    text: value, category, label: category, confidence: 0.9,
    offset: text.indexOf(value), length: value.length,
});

test('a typed query is not expanded into the longest name the run has seen', () => {
    // The run vault already holds the full name from an earlier node.
    const vault = { '[person_1]': 'van Ruben van de Laar' };
    const query = 'Ruben';

    const { tokenizedText, tokenMap } = tokenizeText(query, [span(query, 'Ruben')], vault);

    assert.strictEqual(
        restoreTokens(tokenizedText, { ...vault, ...tokenMap }), query,
        'the query that leaves the platform must be the one the user typed',
    );
    assert.strictEqual(
        Object.values(tokenMap)[0], 'Ruben',
        'the token must carry the typed value, not the longest variant in the vault',
    );
});

test('casing and punctuation of a typed value survive too', () => {
    // Rule 1 (spelling variants) would otherwise hand the query the vault's
    // spelling: "ruben" → "Ruben".
    const vault = { '[person_1]': 'Ruben' };
    const query = 'ruben';
    const { tokenizedText, tokenMap } = tokenizeText(query, [span(query, 'ruben')], vault);
    assert.strictEqual(restoreTokens(tokenizedText, { ...vault, ...tokenMap }), 'ruben');
});

test('surrounding whitespace is preserved byte-for-byte', () => {
    const vault = { '[person_1]': 'van Ruben van de Laar' };
    const query = '  Ruben  ';
    const { tokenizedText, tokenMap } = tokenizeText(query, [span(query, 'Ruben')], vault);
    assert.strictEqual(restoreTokens(tokenizedText, { ...vault, ...tokenMap }), query,
        'no trailing/leading space may appear or disappear — a search API counts them');
});

test('a name inside a SENTENCE still coalesces — the fix is narrow on purpose', () => {
    // Same vault, but now the span is not the whole input: this is prose, and
    // merging "Ruben" onto the full name is exactly what the model needs.
    const vault = { '[person_1]': 'van Ruben van de Laar' };
    const text = 'Stuur de factuur naar Ruben voor vrijdag.';
    const { tokenizedText, tokenMap } = tokenizeText(text, [span(text, 'Ruben')], vault);

    assert.strictEqual(tokenizedText, 'Stuur de factuur naar [person_1] voor vrijdag.',
        'prose must still reuse the existing person token');
    assert.strictEqual(tokenMap['[person_1]'], 'van Ruben van de Laar');
});

test('a whole-input value that is genuinely new still gets a token', () => {
    // The guard is about the VALUE stored, never about skipping detection.
    const query = 'jan@acme.nl';
    const { tokenizedText, tokenMap } = tokenizeText(query, [span(query, 'jan@acme.nl', 'Email')]);
    assert.strictEqual(tokenizedText, '[email_1]');
    assert.strictEqual(tokenMap['[email_1]'], 'jan@acme.nl');
});
