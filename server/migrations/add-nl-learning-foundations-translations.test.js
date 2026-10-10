/**
 * The Dutch of the Bee Flow Foundations course content (BFSF-474): every key
 * exists in the English catalogue, none is left English or blank (the
 * SAME_AS_ENGLISH list excuses the product's own names), the placeholders
 * survive, and the English catalogue itself is not Dutch for these keys.
 *
 * Run: node --test --test-force-exit migrations/add-nl-learning-foundations-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-learning-foundations-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('no Dutch value is blank or the English one copied over', () => {
    const SAME_IN_BOTH = new Set(SAME_AS_ENGLISH);
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        if (SAME_IN_BOTH.has(k)) continue;
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
    // The excuse list is exact: a key on it must exist, and must NOT also be
    // translated (a real translation makes the excuse a lie).
    for (const k of SAME_AS_ENGLISH) {
        assert.ok(k in GUI_DEFAULTS, `${k} on SAME_AS_ENGLISH but not in the English catalog`);
        assert.ok(!(k in NL_TRANSLATIONS), `${k} is excused AND translated — pick one`);
    }
});

test('the English catalog is not Dutch for these keys', () => {
    // The marker list stays clear of words the English lessons legitimately
    // quote as Dutch example prompts ("Een monteur van Van Dijk Groep…").
    const DUTCH_MARKERS = /\b(cursussen|cursus|afgerond|beheerst|vergrendeld|werkruimte|onthuld|volgende|opnieuw)\b/i;
    const dutch = Object.keys(NL_TRANSLATIONS).filter(k => DUTCH_MARKERS.test(GUI_DEFAULTS[k] || ''));
    assert.deepStrictEqual(dutch, [], 'these English catalog entries hold Dutch text');
});

test('placeholders survive translation', () => {
    for (const [k, nl] of Object.entries(NL_TRANSLATIONS)) {
        const en = GUI_DEFAULTS[k] || '';
        const want = (en.match(/\{[a-z]+\}/g) || []).sort();
        const got = (nl.match(/\{[a-z]+\}/g) || []).sort();
        assert.deepStrictEqual(got, want, `${k}: placeholders differ (en ${want.join(',')} vs nl ${got.join(',')})`);
    }
});
