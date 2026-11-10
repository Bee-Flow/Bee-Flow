/**
 * The Dutch of the corrected action limits in the lesson quiz. Pins: every key exists in
 * English, the new Dutch is what the catalogue data now ships, own wording survives, a
 * second run changes nothing, and boot runs it after the catalogue that shipped the old Dutch.
 *
 * Run: node --test migrations/update-nl-learn-action-limits-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_REWORDED, applyNl } = require('./update-nl-learn-action-limits-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('each reworded key exists in English and carries the real limits', () => {
    for (const key of Object.keys(NL_REWORDED)) assert.ok(key in GUI_DEFAULTS, key);
    assert.ok(GUI_DEFAULTS['learn.apps-actions-and-automations.q-caps.explanation'].includes('120 steps'));
});

test('the new Dutch is what the catalogue data now ships, and differs from the old and the English', () => {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'learn-content-2026-10-nl.json'), 'utf8'));
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.strictEqual(data.translations[key], now, key);
        assert.ok(!was.includes(now), key);
        assert.notStrictEqual(now, GUI_DEFAULTS[key], key);
    }
});

test('old shipped Dutch and a missing key get the new text; own wording stays; a second run changes nothing', () => {
    const keys = Object.keys(NL_REWORDED);
    const old = Object.fromEntries(keys.map((k) => [k, NL_REWORDED[k].was[0]]));
    const fromOld = applyNl({ ...old, unrelated: 'blijft' });
    for (const k of keys) assert.strictEqual(fromOld.merged[k], NL_REWORDED[k].now, k);
    assert.strictEqual(fromOld.merged.unrelated, 'blijft');
    assert.strictEqual(applyNl({}).reworded, keys.length);
    assert.strictEqual(applyNl({ [keys[0]]: 'Eigen tekst' }).merged[keys[0]], 'Eigen tekst');
    assert.strictEqual(applyNl({ ...fromOld.merged }).reworded, 0);
});

test('boot runs it after the catalogue that shipped the old Dutch', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const me = ladder.indexOf('update-nl-learn-action-limits-2026-11');
    assert.ok(me > 0, 'not in the boot ladder');
    assert.ok(ladder.indexOf('add-nl-learn-content-2026-10-translations') < me);
});
