/**
 * Every chat request-error key has an English default and a Dutch
 * value that keeps its placeholders.
 *
 * Run: node --test migrations/add-nl-chat-request-errors-translations.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-chat-request-errors-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('each key exists in English and has a different, non-blank Dutch value', () => {
    for (const [key, nl] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(key in GUI_DEFAULTS, `${key} missing from the English catalogue`);
        assert.ok(String(nl).trim(), `${key} has a blank NL value`);
        assert.notStrictEqual(nl, GUI_DEFAULTS[key]);
    }
});

test('placeholders survive the translation', () => {
    for (const [key, nl] of Object.entries(NL_TRANSLATIONS)) {
        const en = String(GUI_DEFAULTS[key]).match(/\{\w+\}/g) || [];
        for (const p of en) assert.ok(String(nl).includes(p), `${key} lost ${p}`);
    }
});
