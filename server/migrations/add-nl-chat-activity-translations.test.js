/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English key with no Dutch one
 * is a card that says "Working" above a Dutch answer.
 *
 * Run: node --test --test-force-exit migrations/add-nl-chat-activity-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-chat-activity-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const owned = (key) => key.startsWith('chat.act.');

test('every English chat.act.* key has a Dutch one', () => {
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS));
    assert.deepStrictEqual(untranslated, []);
});
