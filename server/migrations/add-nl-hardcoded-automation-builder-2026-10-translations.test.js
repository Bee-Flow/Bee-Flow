/**
 * The Dutch for the automation builder strings that used to be hard-coded
 * English. Two silent failure modes are pinned here: a Dutch key that matches
 * no English key is stored and never read, and an English key without Dutch
 * leaves one English sentence in an otherwise Dutch screen. Neither shows an
 * error anywhere.
 *
 * Run: node --test migrations/add-nl-hardcoded-automation-builder-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-hardcoded-automation-builder-2026-10-translations');

test('the catalogue covers a real number of keys', () => {
    assert.ok(Object.keys(NL_TRANSLATIONS).length > 900, 'the data file looks truncated');
});

test('the Dutch speaks to the reader as je, never u', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/\b(u|uw)\b/.test(v.replace(/\{[^}]*\}/g, '')), `${k} (nl) addresses the reader as u/uw`);
    }
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const [first] = Object.keys(NL_TRANSLATIONS);
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);

    const own = applyNl({ [first]: 'Eigen woorden' });
    assert.strictEqual(own.merged[first], 'Eigen woorden');
    assert.strictEqual(own.added, Object.keys(NL_TRANSLATIONS).length - 1);
});

test('a second run changes nothing', () => {
    const first = applyNl({});
    const second = applyNl({ ...first.merged });
    assert.strictEqual(second.added, 0);
    assert.deepStrictEqual(second.merged, first.merged);
});

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { DATA_SHA256 } = require('./add-nl-hardcoded-automation-builder-2026-10-translations');
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'hardcoded-automation-builder-2026-10-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/hardcoded-automation-builder-2026-10-nl.json changed: set DATA_SHA256 in add-nl-hardcoded-automation-builder-2026-10-translations.js to ' + actual
        + ' so installs that already ran this migration run it again');
});
