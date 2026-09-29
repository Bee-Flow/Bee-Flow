/**
 * The same two silent failure modes as the round-2 catalogue, for the five
 * namespaces round 3 introduced: a Dutch key with no English one is stored and
 * never read, and an English key with no Dutch one is an English sentence in
 * the middle of a Dutch Privacy Shield — which no error anywhere reports.
 *
 * Run: node --test migrations/add-nl-privacy-shield-v3-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, up } = require('./add-nl-privacy-shield-v3-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** This round introduced these namespaces entirely, so every key in them is this catalogue's. */
const OWNED_PREFIXES = ['shield_shell.', 'shield_overview.', 'shield_look.', 'shield_checks.', 'shield_activity.'];
const owned = (k) => OWNED_PREFIXES.some(p => k.startsWith(p));

/**
 * The same in both languages: setting and level names the NL catalogue keeps
 * English ("How strict", "Low", "High", "tools open" beside "check on"),
 * "Type", "Tool", "Routines", a bare percentage and the placeholder example.
 */
const SAME_AS_ENGLISH = new Set([
    'shield_activity.d_type',
    'shield_activity.pct',
    'shield_activity.type_tool',
    'shield_checks.tokenize_desc_example',
    'shield_look.strict_high',
    'shield_look.strict_low',
    'shield_look.strict_title',
    'shield_overview.row_routines',
    'shield_shell.summary_tools_open',
]);

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never translated; if it really is the same word, move it to SAME_AS_ENGLISH`);
    }
});

test('every interpolation placeholder survives translation', () => {
    const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const [k, nl] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(names(nl), names(GUI_DEFAULTS[k] || ''), `${k}: the Dutch does not carry the same {placeholders}`);
    }
});

test('every English key in the round-3 namespaces has Dutch', () => {
    const missing = Object.keys(GUI_DEFAULTS).filter(k => owned(k) && !(k in NL_TRANSLATIONS) && !SAME_AS_ENGLISH.has(k));
    assert.deepStrictEqual(missing, [], 'these English strings would render in English on a Dutch screen');
    assert.ok(Object.keys(GUI_DEFAULTS).filter(owned).length > 150, 'the round-3 namespaces are missing from the English catalog');
});

test('the strings declared identical exist and are not also translated', () => {
    for (const k of SAME_AS_ENGLISH) {
        assert.ok(k in GUI_DEFAULTS, `${k} is not an English key`);
        assert.ok(!(k in NL_TRANSLATIONS), `${k} is declared identical but also translated`);
    }
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-privacy-shield-v3-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
});
