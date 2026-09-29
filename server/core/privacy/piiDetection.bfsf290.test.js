/**
 * BFSF-290 regression: the Dutch message from the ticket (its shape, with
 * fictional values) must leave the box with every PII value replaced by a
 * placeholder, and come back with the real values restored.
 *
 * The reported failure was upstream of this (the runtime never resolved the
 * personal account's shield, so tokenizeText was never called — see
 * core/orgShield.userShield.test.js). This test pins the second half of the
 * contract: given detected entities, nothing sensitive survives into the
 * outbound string, and the round-trip is lossless.
 *
 * Run: cd server && node --test core/piiDetection.bfsf290.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { tokenizeText, restoreTokens } = require('./piiDetection');

// The message from the ticket, same sentence shape with fictional values.
const MESSAGE = 'Ruben@example.com is het e-mailadres van Ruben van der Laar. '
    + 'Hij woont op de Piet van Dalenstraat 7 in Utrecht en hij is te bereiken op 0612345678';

// What a healthy guard-service scan returns for it (offsets computed below so
// the fixture can't silently drift out of sync with the sentence).
function entity(text, category, label) {
    const offset = MESSAGE.indexOf(text);
    assert.notEqual(offset, -1, `fixture out of sync: "${text}" not in the message`);
    return { text, category, label, confidence: 0.9, offset, length: text.length };
}

const ENTITIES = [
    entity('Ruben@example.com', 'Email', 'Email Address'),
    entity('Ruben van der Laar', 'Person', 'Person Name'),
    entity('Piet van Dalenstraat 7', 'Address', 'Physical Address'),
    entity('0612345678', 'PhoneNumber', 'Phone Number'),
];

test('tokenize: no raw PII value survives into the outbound text', () => {
    const { tokenizedText, tokenMap } = tokenizeText(MESSAGE, ENTITIES);

    for (const e of ENTITIES) {
        assert.ok(!tokenizedText.includes(e.text),
            `"${e.text}" (${e.label}) leaked into the text sent to the model`);
    }
    assert.equal(Object.keys(tokenMap).length, ENTITIES.length);
    // Placeholders are the [category_n] shape the system prompt tells the model about.
    for (const token of Object.keys(tokenMap)) {
        assert.match(token, /^\[[a-z0-9_]+_\d+\]$/, `unexpected placeholder shape: ${token}`);
        assert.ok(tokenizedText.includes(token), `${token} missing from the tokenised text`);
    }
});

test('tokenize: non-PII context is preserved verbatim', () => {
    const { tokenizedText } = tokenizeText(MESSAGE, ENTITIES);
    assert.ok(tokenizedText.includes('is het e-mailadres van'));
    assert.ok(tokenizedText.includes('Hij woont op de'));
    assert.ok(tokenizedText.includes('in Utrecht'));
});

test('round-trip: the reply the user sees has the real values back', () => {
    const { tokenizedText, tokenMap } = tokenizeText(MESSAGE, ENTITIES);
    assert.equal(restoreTokens(tokenizedText, tokenMap), MESSAGE);
});

test('round-trip: placeholders inside a model reply are restored', () => {
    const { tokenMap } = tokenizeText(MESSAGE, ENTITIES);
    const emailToken = Object.keys(tokenMap).find(t => tokenMap[t] === 'Ruben@example.com');
    const nameToken = Object.keys(tokenMap).find(t => tokenMap[t] === 'Ruben van der Laar');
    assert.ok(emailToken && nameToken, 'expected tokens for the email and the name');

    const modelReply = `Ik stuur een mail naar ${emailToken} voor ${nameToken}.`;
    assert.equal(
        restoreTokens(modelReply, tokenMap),
        'Ik stuur een mail naar Ruben@example.com voor Ruben van der Laar.',
    );
});

test('no entities → text untouched, empty map', () => {
    const { tokenizedText, tokenMap } = tokenizeText(MESSAGE, []);
    assert.equal(tokenizedText, MESSAGE);
    assert.deepEqual(tokenMap, {});
});
