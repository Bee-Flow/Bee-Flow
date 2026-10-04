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

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated — if the Dutch really is the English word, move it to SAME_AS_ENGLISH`);
    }
});

test('every English app-builder key has a Dutch one (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the two builders share one vocabulary where they say the same thing', () => {
    // A presenter switching between the automation film and the app film must
    // read the same words for the same state.
    const automation = require('./add-nl-builder-redesign-translations').NL_TRANSLATIONS;
    assert.strictEqual(NL_TRANSLATIONS['app_studio.builder.banner.build_live'], automation['automations.canvas.build_live']);
    assert.strictEqual(NL_TRANSLATIONS['app_studio.builder.banner.build_stopped'], automation['automations.canvas.build_stopped']);
    assert.strictEqual(NL_TRANSLATIONS['app_studio.builder.banner.follow'], automation['automations.canvas.build_follow']);
});

test('the migration is registered, or it never runs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-app-studio-builder-translations'"), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});
