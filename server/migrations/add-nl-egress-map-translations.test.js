/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English map string with no
 * Dutch one is an English sentence in the middle of a Dutch Privacy Shield,
 * on the screen that tells an admin where their data went.
 *
 * Run: node --test migrations/add-nl-egress-map-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, up } = require('./add-nl-egress-map-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** Identical in Dutch: a city and a country code, "via", "Type" and "Tool", and number formats. */
const SAME_AS_ENGLISH = new Set([
    'egress_map.place_city',
    'egress_map.short_via',
    'egress_map.short_via_only',
    // Round 3: a column name, and two formats that are only numbers and a kind.
    'egress_map.col_type',
    'egress_map.kind_option',
    'egress_map.label_kind_n',
    'egress_map.type_tool',
]);

const OWNED = (k) => k.startsWith('egress_map.');

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated; if it really is the same, add it to SAME_AS_ENGLISH`);
    }
});

test('every English egress_map string has a Dutch one', () => {
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED(k) && !(k in NL_TRANSLATIONS) && !SAME_AS_ENGLISH.has(k))
        .sort();
    assert.deepStrictEqual(untranslated, [], `English only: ${untranslated.join(', ')}`);
    assert.ok(Object.keys(GUI_DEFAULTS).filter(OWNED).length > 40, 'the egress_map namespace is missing from the English catalog');
});

test('the strings declared identical exist and are not also translated', () => {
    for (const k of SAME_AS_ENGLISH) {
        assert.ok(k in GUI_DEFAULTS, `${k} is declared identical but does not exist in English`);
        assert.ok(!(k in NL_TRANSLATIONS), `${k} is both declared identical AND translated`);
    }
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('no dashes as punctuation, in either language', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
    for (const k of Object.keys(GUI_DEFAULTS).filter(OWNED)) assert.ok(!/[–—]/.test(GUI_DEFAULTS[k]), `${k} (en) uses a dash`);
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-egress-map-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
});
