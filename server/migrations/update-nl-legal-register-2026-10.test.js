/**
 * Dutch for the legal register review of 6 Oct 2026. Pins: every key exists
 * in English, the rewording only replaces the OLD shipped Dutch (a workspace's
 * own wording survives), the new Dutch matches the seed map, and the data hash.
 *
 * Run: node --test migrations/update-nl-legal-register-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl, DATA_SHA256 } = require('./update-nl-legal-register-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const SEED = require('./data/compliance-center-nl.json');

test('the pinned hash is the data file\'s, so a data change re-runs the migration', () => {
    const data = fs.readFileSync(path.join(__dirname, 'data', 'legal-register-2026-10-nl.json'));
    assert.strictEqual(crypto.createHash('sha256').update(data).digest('hex'), DATA_SHA256);
});

test('every key exists in the English catalog, has Dutch, and is not the English copied over', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...Object.keys(NL_REWORDED)];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    for (const k of Object.keys(NL_TRANSLATIONS)) {
        assert.ok(NL_TRANSLATIONS[k].trim(), `${k}: empty`);
        assert.notStrictEqual(NL_TRANSLATIONS[k], GUI_DEFAULTS[k], `${k}: English copied`);
    }
    for (const [k, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && was.trim(), `${k}: empty`);
        assert.notStrictEqual(now, was, `${k}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[k], `${k}: English copied`);
    }
});

test('the seed map carries the same new Dutch, so a fresh install and an upgraded one agree', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.strictEqual(SEED[k], v, k);
    for (const [k, { now }] of Object.entries(NL_REWORDED)) assert.strictEqual(SEED[k], now, k);
});

test('applyNl adds missing keys, replaces the old shipped Dutch, and keeps a workspace\'s own wording', () => {
    const [rewordKey, { was, now }] = Object.entries(NL_REWORDED)[0];
    const [otherKey] = Object.keys(NL_REWORDED).slice(1);
    const [newKey] = Object.keys(NL_TRANSLATIONS);
    const blob = { [rewordKey]: was, [otherKey]: 'Onze eigen formulering', unrelated: 'blijft' };
    const { merged, added, reworded } = applyNl({ ...blob });
    assert.strictEqual(merged[rewordKey], now);
    assert.strictEqual(merged[otherKey], 'Onze eigen formulering');
    assert.strictEqual(merged[newKey], NL_TRANSLATIONS[newKey]);
    assert.strictEqual(merged.unrelated, 'blijft');
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.ok(reworded >= 1);
    // Idempotent: a second run changes nothing.
    const again = applyNl({ ...merged });
    assert.deepStrictEqual(again.merged, merged);
    assert.strictEqual(again.added, 0);
});
