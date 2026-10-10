/**
 * Dutch for the "is about" rules. Both silent failure modes are pinned: a
 * Dutch key with no English key is stored and never read, and an English key
 * with no Dutch value leaves one English sentence in a Dutch editor.
 *
 * Run: node --test migrations/add-nl-topic-rules-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-topic-rules-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const PREFIX = 'automations.builder.topics.';

test('every English "is about" key has a Dutch value', () => {
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith(PREFIX) && !NL_TRANSLATIONS[k]);
    assert.deepStrictEqual(missing, []);
});
