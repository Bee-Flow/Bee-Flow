'use strict';

/**
 * `neutraliseTokens` — the last step of any copy that LEAVES its conversation.
 *
 * The contract is stated against `restoreTokens`, because the gap between the
 * two IS the leak: every shape restoreTokens will substitute must be gone, and
 * nothing else may be touched. So the test does not just assert on strings —
 * it feeds the output back through the real `restoreTokens` with a populated
 * map and asserts that nothing comes out changed.
 *
 * Run: cd server && node --test core/privacy/piiDetection/tokenNeutralise.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { neutraliseTokens } = require('./tokenNeutralise');
const { restoreTokens } = require('./tokenRestore');

/** A reader's map — a DIFFERENT conversation's people behind the same keys. */
const READER_MAP = {
    '[person_1]': 'Sofie de Wit',
    '[person_2]': 'Ahmed Yilmaz',
    '[email_1]': 'sofie@example.com',
    '[email_2]': 'ahmed@example.com',
    '[iban_1]': 'NL91ABNA0417164300',
    '[iban_2]': 'NL02RABO0123456789',
    '[organization_1]': 'De Vries BV',
};

test('the minted shape goes, and is named in words', () => {
    assert.equal(
        neutraliseTokens('Tell [person_1] that [iban_2] bounced.'),
        'Tell someone that a bank account bounced.',
    );
});

test('the drift shapes the MODEL writes go too — restoreTokens accepts those as well', () => {
    assert.equal(neutraliseTokens('Mail [email]2 now.'), 'Mail an email address now.');
    assert.equal(neutraliseTokens('Ask [person3] first.'), 'Ask someone first.');
    assert.equal(neutraliseTokens('[PII:person:4] signed.'), 'someone signed.');
    assert.equal(neutraliseTokens('[REDACTED:iban] was blocked.'), 'a bank account was blocked.');
});

test('an unknown category still loses its token rather than keeping a key', () => {
    const out = neutraliseTokens('See [zorgverzekeraar_1] for the rest.');
    assert.equal(out, 'See a personal detail for the rest.');
    assert.ok(!out.includes('['));
});

test('ordinary bracketed prose is left exactly as it was', () => {
    for (const text of [
        'See [the quote] for the rest.',
        'A markdown [link](https://example.com) stays a link.',
        'Array notation like items[0] is untouched.',
        'An empty message',
    ]) {
        assert.equal(neutraliseTokens(text), text, text);
    }
});

test('a string with no bracket at all comes back identical, and a non-string is empty', () => {
    assert.equal(neutraliseTokens('Nothing personal here.'), 'Nothing personal here.');
    assert.equal(neutraliseTokens(null), '');
    assert.equal(neutraliseTokens(undefined), '');
    assert.equal(neutraliseTokens(42), '');
});

/**
 * THE POINT. A stored example is read back on somebody ELSE'S turn, and their
 * restore pass runs with THEIR map. Before this function, `[person_1]` in an
 * example became that reader's own customer — under a card saying "personal
 * data removed".
 */
test('nothing survives that the reader\'s own restore pass could substitute', () => {
    const fromAnotherChat = [
        'Tell [person_1] that [iban_2] bounced; cc [email]2 and [person3].',
        '[PII:person:1] asked about [organization_1].',
        '[REDACTED:email] was on the invoice.',
    ].join('\n');

    // Proof the map WOULD have bitten, so the assertion below is not vacuous.
    const unsafe = restoreTokens(fromAnotherChat, READER_MAP);
    assert.notEqual(unsafe, fromAnotherChat, 'the fixture must actually be restorable');
    assert.ok(unsafe.includes('Sofie de Wit'));

    const safe = neutraliseTokens(fromAnotherChat);
    assert.equal(restoreTokens(safe, READER_MAP), safe, 'the reader\'s map must find nothing to replace');
    for (const value of Object.values(READER_MAP)) {
        assert.ok(!restoreTokens(safe, READER_MAP).includes(value), `${value} came back`);
    }
});
