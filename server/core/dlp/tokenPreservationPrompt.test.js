/**
 * The token-preservation addendum must tell the model that a token IS the
 * value: a user whose memory reads "My name is [person_7]" asked "what is my
 * name and email?" and was told the name was unknown, because the old text
 * only said tokens are redacted data that must not be decoded.
 *
 * Run: cd server && node --test core/dlp/tokenPreservationPrompt.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildTokenPreservationAddendum } = require('./tokenPreservationPrompt');

test('empty or missing map: no addendum', () => {
    assert.strictEqual(buildTokenPreservationAddendum(null), '');
    assert.strictEqual(buildTokenPreservationAddendum({}), '');
    assert.strictEqual(buildTokenPreservationAddendum(new Map()), '');
});

test('lists the tokens and covers memories, not only the user message', () => {
    const text = buildTokenPreservationAddendum({ '[person_7]': 'tom', '[email_1]': 'tom@example.test' });
    assert.ok(text.includes('`[person_7]`') && text.includes('`[email_1]`'));
    assert.ok(text.includes('<memories>'), 'names the memory block as a place where tokens appear');
});

test('a token is the answer: asked for the value, the model answers with the token', () => {
    const text = buildTokenPreservationAddendum({ '[person_7]': 'tom' });
    assert.match(text, /A token is the answer/);
    assert.match(text, /what is my name\?/);
    assert.match(text, /Your name is \[person_1\]/);
    assert.match(text, /"My name is \[person_1\]" means the user is \[person_1\]/);
    assert.match(text, /Never answer that you do not know/);
});

test('still forbids decoding and inventing placeholders', () => {
    const text = buildTokenPreservationAddendum({ '[person_7]': 'tom' });
    assert.match(text, /Never decode, guess, or reconstruct/);
    assert.match(text, /Never invent new bracketed placeholders/);
});

test('caps the listed tokens at 30 and counts the rest', () => {
    const map = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`[person_${i + 1}]`, `p${i}`]));
    const text = buildTokenPreservationAddendum(map);
    assert.ok(text.includes('`[person_30]`'));
    assert.ok(!text.includes('`[person_31]`'));
    assert.ok(text.includes('(+3 more)'));
});
