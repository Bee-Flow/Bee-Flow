/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English key with no Dutch one
 * is a handoff card that says "Continue" in the middle of a Dutch Studio.
 *
 * Run: node --test --test-force-exit migrations/add-nl-playbooks-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-playbooks-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIXES = ['playbooks.', 'studio.tab.playbooks', 'studio.new.playbook'];
const owned = (key) => OWNED_PREFIXES.some((p) => key.startsWith(p));

test('every English playbooks key has a Dutch one (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('the playbook speaks the builders\' words for the shared states', () => {
    const app = require('./add-nl-app-studio-builder-translations').NL_TRANSLATIONS;
    assert.strictEqual(NL_TRANSLATIONS['playbooks.state.running'], app['app_studio.builder.act.building']);
});
