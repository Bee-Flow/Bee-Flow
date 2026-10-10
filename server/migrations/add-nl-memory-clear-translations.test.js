/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English key with no Dutch one
 * is a dialog that asks "Delete all memories of this project?" in the middle
 * of a Dutch project page.
 *
 * Run: node --test migrations/add-nl-memory-clear-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-memory-clear-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIX = 'settings.memory_clear_';

test('every English memory-clear key has a Dutch one', () => {
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith(OWNED_PREFIX) && !(k in NL_TRANSLATIONS));
    assert.deepStrictEqual(untranslated, []);
});
