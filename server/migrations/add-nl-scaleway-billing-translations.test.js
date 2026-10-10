/**
 * Two silent failure modes, both pinned here: a Dutch key that matches no
 * English key is stored and never read, and an English key with no Dutch one
 * is an English sentence on the Scaleway Billing card of a Dutch settings page.
 *
 * Run: node --test migrations/add-nl-scaleway-billing-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-scaleway-billing-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIXES = ['integ.scaleway_billing_', 'connections.field_scaleway_billing_'];
const owned = (key) => OWNED_PREFIXES.some((p) => key.startsWith(p));

test('no Dutch value is blank or the English one copied over, and none is both', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: identical to English; move it to SAME_AS_ENGLISH`);
    }
    assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
});

test('every English Scaleway Billing key has a Dutch one (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation, and no dashes are used as punctuation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
    }
});

test('the Dutch says automatisering, not routine', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/routine/i.test(v), `${k} (nl) still says routine`);
    }
});
