/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English key with no Dutch one
 * is a switch that says "Use memory" in the middle of a Dutch settings page.
 *
 * Run: node --test --test-force-exit migrations/add-nl-memory-switch-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-memory-switch-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// Exact prefixes, not `settings.memory_`: the older import/export keys under
// that prefix are seeded elsewhere and are not this migration's to claim.
const OWNED_PREFIXES = ['settings.memory_switch', 'settings.memory_stats_', 'settings.memory_type_'];
const owned = (key) => OWNED_PREFIXES.some((p) => key.startsWith(p));

test('every English memory-switch key has a Dutch one (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});
