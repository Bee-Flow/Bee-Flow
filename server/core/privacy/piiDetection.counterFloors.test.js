/**
 * Counter floors — the tokenizer half of the tokenization vault.
 *
 * The seed map handed to tokenizeText only contains vault entries that MATCHED
 * the current text. Without a floor, a value the vault has never seen would
 * mint `[person_2]` while the vault already holds a different `[person_2]` from
 * another conversation: two people sharing one placeholder, and a vault whose
 * unique-token index then silently rejects the second one.
 *
 * Floors are high-water marks. They never decrease — not on eviction, not on
 * delete — because reissuing a number would re-point a token still sitting in
 * a saved message.
 */

const test = require('node:test');
const assert = require('node:assert');

const { tokenizeText } = require('./piiDetection');

function entity(text, offset, category = 'Person') {
    return { text, offset, length: text.length, category };
}

test('a floor pushes a fresh mint above every token the vault has issued', () => {
    const { tokenMap } = tokenizeText('Call Marieke about it', [entity('Marieke', 5)], null, {
        counterFloors: { person: 4 },
    });
    assert.deepStrictEqual(Object.keys(tokenMap), ['[person_5]']);
});

test('without floors the tokenizer starts at 1, exactly as before', () => {
    const { tokenMap } = tokenizeText('Call Marieke', [entity('Marieke', 5)], null);
    assert.deepStrictEqual(Object.keys(tokenMap), ['[person_1]']);
});

test('a floor never lowers a counter the conversation already established', () => {
    const { tokenMap } = tokenizeText('Call Marieke', [entity('Marieke', 5)], { '[person_9]': 'Bob' }, {
        counterFloors: { person: 2 },
    });
    assert.ok(tokenMap['[person_10]'], 'the higher of conversation and vault wins');
});

test('floors are per category', () => {
    const { tokenMap } = tokenizeText('Marieke at marieke@example.test', [
        entity('Marieke', 0),
        entity('marieke@example.test', 11, 'Email'),
    ], null, { counterFloors: { person: 7 } });
    assert.ok(tokenMap['[person_8]'], 'person continues above its own floor');
    assert.ok(tokenMap['[email_1]'], 'email is untouched by the person floor');
});

test('a malformed floor is ignored rather than corrupting the counter', () => {
    for (const bad of ['not-a-number', null, -3, undefined, {}]) {
        const { tokenMap } = tokenizeText('Call Marieke', [entity('Marieke', 5)], null, {
            counterFloors: { person: bad },
        });
        assert.deepStrictEqual(Object.keys(tokenMap), ['[person_1]'], `floor ${JSON.stringify(bad)}`);
    }
});

test('a seeded value reuses its token instead of minting a new one', () => {
    // The property the whole feature promises: conversation B has never seen
    // this person, but the vault has, so the placeholder matches conversation A.
    const seed = { '[person_12]': 'Theodorus van der Brug' };
    const { tokenizedText, tokenMap } = tokenizeText(
        'Please email Theodorus van der Brug today',
        [entity('Theodorus van der Brug', 13)],
        seed,
        { counterFloors: { person: 12 } },
    );
    assert.ok(tokenizedText.includes('[person_12]'), 'the stable token is reused');
    assert.strictEqual(tokenMap['[person_12]'], 'Theodorus van der Brug');
    assert.strictEqual(Object.keys(tokenMap).length, 1, 'and no duplicate is minted alongside it');
});

test('options are optional — the old three-argument call still works', () => {
    const { tokenMap } = tokenizeText('Call Marieke', [entity('Marieke', 5)], null);
    assert.deepStrictEqual(Object.keys(tokenMap), ['[person_1]']);
});
