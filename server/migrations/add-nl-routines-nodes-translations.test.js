/**
 * The Dutch node catalog must line up with the English one, exactly.
 *
 * Both failure modes are silent, which is why they need a test:
 *   - a key with a typo is stored, never read, and the UI quietly stays English
 *     with no error anywhere;
 *   - a new node added to nodeDefs.js reaches the English dictionary via the
 *     i18n parity guard, but nothing would have noticed it had no Dutch.
 *
 * Run: node --test migrations/add-nl-routines-nodes-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-routines-nodes-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const enKeys = Object.keys(GUI_DEFAULTS).filter(k => k.startsWith('routines.node.'));
const nlKeys = Object.keys(NL_TRANSLATIONS);

test('every Dutch key exists in the English catalog (no typo'
    + ' — a key that matches nothing is stored and never read)', () => {
    const orphans = nlKeys.filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('every node-catalog key has a Dutch value', () => {
    const missing = enKeys.filter(k => !(k in NL_TRANSLATIONS));
    assert.deepStrictEqual(missing, [], 'add these to the nl migration, or the picker stays English for them');
});

test('no Dutch value is just the English one copied over', () => {
    // Proper nouns and words Dutch shares are fine; this catches wholesale
    // copy-paste of a block that was never actually translated.
    const identical = enKeys.filter(k => NL_TRANSLATIONS[k] === GUI_DEFAULTS[k]);
    const allowed = new Set([
        'routines.node.trigger.typeLabel', 'routines.node.trigger.defaultLabel',
        'routines.node.call_layer.typeLabel', 'routines.node.call_layer.defaultLabel',
        'routines.node.code.typeLabel', 'routines.node.code.defaultLabel', 'routines.node.code.label',
        'routines.node.parallel.typeLabel', 'routines.node.parallel.defaultLabel',
    ]);
    assert.deepStrictEqual(identical.filter(k => !allowed.has(k)), []);
});

test('no Dutch value is blank', () => {
    const blank = nlKeys.filter(k => !String(NL_TRANSLATIONS[k] || '').trim());
    assert.deepStrictEqual(blank, []);
});
