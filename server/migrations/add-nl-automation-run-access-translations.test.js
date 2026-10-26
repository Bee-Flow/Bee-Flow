/**
 * The Dutch for the "you may view but not start" hint. Pins the silent failure
 * modes: an English automations.run key without Dutch leaves English on a Dutch
 * screen, a Dutch key without an English one is never read.
 *
 * Run: node --test migrations/add-nl-automation-run-access-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-automation-run-access-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English automations.run key has Dutch, and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('automations.run.'));
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'automations.run.viewOnlyHint': 'Eigen woorden' });
    assert.strictEqual(own.merged['automations.run.viewOnlyHint'], 'Eigen woorden');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
