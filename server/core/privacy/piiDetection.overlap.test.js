/**
 * Overlapping spans must never corrupt the tokenised text or the token map.
 *
 * Splicing placeholders by offset, from the tail forwards, is only safe for
 * DISJOINT spans. Two overlapping spans and the second splice's tail slice
 * starts INSIDE the placeholder the first one wrote. The failure as it showed
 * up in production with a pasted meeting transcript (names fictional):
 *
 *     [person_8]  ->  "Theodorus van der Brugrganization_1"
 *                                            ^^^ the "[o" of [organization_1]
 *
 * The token map then holds a string that never existed in the user's text, and
 * the next turn's scan detects the corrupted fragment as a fresh entity.
 *
 * Overlaps are routine, not exotic: `mergeWindowResults` deduped on the exact
 * triple `offset:length:category`, so an entity the 8k window boundary clipped
 * in one window and left whole in the next — SAME offset, DIFFERENT length —
 * passed as two distinct spans.
 *
 * Run: node --test server/core/piiDetection.overlap.test.js
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

const { tokenizeText, mergeWindowResults } = require('./piiDetection');

/** Every token in the output must be a complete `[category_n]`, never a fragment. */
function assertNoPlaceholderFragments(out) {
    // Any '[' or ']' that is not part of a well-formed token is a splice wound.
    const stripped = out.replace(/\[[a-z0-9_]+_\d+\]/g, '');
    assert.ok(!stripped.includes('['), `dangling '[' in: ${out}`);
    assert.ok(!stripped.includes(']'), `dangling ']' in: ${out}`);
    // The classic signature: a token name's tail left behind in the text.
    assert.ok(!/rganization_\d/.test(stripped), `placeholder tail leaked: ${out}`);
}

test('overlapping spans do not splice into each other', () => {
    const text = 'Aanwezig: Theodorus van der Brug namens Dekker Techniek.';
    const orgOffset = text.indexOf('Dekker Techniek');
    const personOffset = text.indexOf('Theodorus');
    // The Person span runs two characters INTO the Organization span — exactly
    // what a window boundary produces when one side clipped the name.
    const entities = [
        { text: 'Dekker Techniek', category: 'Organization', offset: orgOffset, length: 'Dekker Techniek'.length, confidence: 0.9 },
        {
            text: text.slice(personOffset, orgOffset + 2),
            category: 'Person',
            offset: personOffset,
            length: (orgOffset + 2) - personOffset,
            confidence: 0.95,
        },
    ];

    const { tokenizedText, tokenMap } = tokenizeText(text, entities);

    assertNoPlaceholderFragments(tokenizedText);
    for (const [token, value] of Object.entries(tokenMap)) {
        assert.ok(text.includes(value), `${token} → "${value}" is not a slice of the source text`);
    }
});

test('every token map value is a verbatim slice of the source text', () => {
    const text = 'Bel Tom Smit van 24x7 ICT op 0612345678.';
    // Deliberately wrong `text` fields: the offsets are authoritative, so the
    // map must record what was actually removed, not what the caller claimed.
    const entities = [
        { text: 'WRONG', category: 'Person', offset: text.indexOf('Tom Smit'), length: 'Tom Smit'.length, confidence: 0.9 },
        { text: 'ALSO WRONG', category: 'PhoneNumber', offset: text.indexOf('0612345678'), length: 10, confidence: 0.9 },
    ];

    const { tokenizedText, tokenMap } = tokenizeText(text, entities);

    assert.deepStrictEqual(Object.values(tokenMap).sort(), ['0612345678', 'Tom Smit']);
    assert.ok(!tokenizedText.includes('Tom Smit'));
    assert.ok(!tokenizedText.includes('0612345678'));
});

test('a span clipped by a window boundary merges with the whole span', () => {
    // Window A ends mid-name, so it reports "Theodorus van der" (offset 10,
    // length 17); window B reports the whole "Theodorus van der Brug" at the
    // same absolute offset. Same offset, different length -> two keys.
    const text = 'Aanwezig: Theodorus van der Brug en verder niemand.';
    const parts = [
        { start: 0, result: { entities: [{ text: 'Theodorus van der', category: 'Person', offset: 10, length: 17, confidence: 0.8 }] } },
        { start: 0, result: { entities: [{ text: 'Theodorus van der Brug', category: 'Person', offset: 10, length: 22, confidence: 0.9 }] } },
    ];

    const merged = mergeWindowResults(text, parts, text.length);

    assert.strictEqual(merged.entities.length, 1, 'the clipped and whole span must collapse into one');
    assert.strictEqual(merged.entities[0].length, 22, 'the union keeps the widest extent');
    assert.strictEqual(merged.entities[0].text, 'Theodorus van der Brug');

    // And the whole point: tokenising the merged set is clean.
    const { tokenizedText } = tokenizeText(text, merged.entities);
    assertNoPlaceholderFragments(tokenizedText);
    assert.ok(!tokenizedText.includes('Theodorus'));
});

test('adjacent spans that only touch stay separate tokens', () => {
    const text = 'Tom,Smit';
    const entities = [
        { text: 'Tom', category: 'Person', offset: 0, length: 3, confidence: 0.9 },
        { text: 'Smit', category: 'Organization', offset: 4, length: 4, confidence: 0.9 },
    ];
    const { tokenizedText, tokenMap } = tokenizeText(text, entities);
    assert.strictEqual(Object.keys(tokenMap).length, 2);
    assert.strictEqual(tokenizedText, '[person_1],[organization_1]');
});

test('a disjoint entity list is tokenised exactly as before', () => {
    // Regression guard: overlap resolution must be a no-op on well-formed input.
    const text = 'Mail naar a@b.nl of bel 0612345678.';
    const entities = [
        { text: 'a@b.nl', category: 'Email', offset: text.indexOf('a@b.nl'), length: 6, confidence: 0.99 },
        { text: '0612345678', category: 'PhoneNumber', offset: text.indexOf('0612345678'), length: 10, confidence: 0.95 },
    ];
    const { tokenizedText, tokenMap } = tokenizeText(text, entities);
    assert.strictEqual(tokenizedText, 'Mail naar [email_1] of bel [phonenumber_1].');
    assert.deepStrictEqual(tokenMap, { '[email_1]': 'a@b.nl', '[phonenumber_1]': '0612345678' });
});
