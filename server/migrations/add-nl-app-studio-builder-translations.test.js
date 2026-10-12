/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English key with no Dutch one
 * is a banner that says "Building" in the middle of a Dutch editor.
 *
 * Run: node --test --test-force-exit migrations/add-nl-app-studio-builder-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-app-studio-builder-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIXES = ['app_studio.builder.'];
const owned = (key) => OWNED_PREFIXES.some((p) => key.startsWith(p));

test('every English app-builder key has a Dutch one (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('the two builders share one vocabulary where they say the same thing', () => {
    // A presenter switching between the automation film and the app film must
    // read the same words for the same state.
    const automation = require('./add-nl-builder-redesign-translations').NL_TRANSLATIONS;
    assert.strictEqual(NL_TRANSLATIONS['app_studio.builder.banner.build_live'], automation['automations.canvas.build_live']);
    assert.strictEqual(NL_TRANSLATIONS['app_studio.builder.banner.build_stopped'], automation['automations.canvas.build_stopped']);
    assert.strictEqual(NL_TRANSLATIONS['app_studio.builder.banner.follow'], automation['automations.canvas.build_follow']);
});
