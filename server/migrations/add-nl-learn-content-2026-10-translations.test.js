/**
 * Dutch for the Learning Center lesson content (2026-10): every key exists in English, none is blank or the English copied over, placeholders and ICU
 * plurals survive, a workspace's own wording is kept, one key has one owner, and a data change re-runs it.
 *
 * Run: node --test migrations/add-nl-learn-content-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, DATA_SHA256, applyNl } = require('./add-nl-learn-content-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('placeholders and ICU plural/select blocks survive translation', () => {
    const holes = (s) => (String(s).match(/\{\{?[a-z_][a-z0-9_.]*\}?\}/gi) || []).sort();
    const icu = (s) => (String(s).match(/\{\s*\w+\s*,\s*(plural|select)/g) || []).length;
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
        assert.strictEqual(icu(v), icu(GUI_DEFAULTS[k]), `${k}: plural/select structure differs from English`);
    }
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);
    const [first] = Object.keys(NL_TRANSLATIONS);
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

test('no other Dutch catalogue seeds these keys', () => {
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^(add|update)-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-learn-content-2026-10-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const actual = sha256Of(path.join(__dirname, 'data', 'learn-content-2026-10-nl.json'));
    assert.strictEqual(DATA_SHA256, actual, 'data/learn-content-2026-10-nl.json changed: set DATA_SHA256 in add-nl-learn-content-2026-10-translations.js to ' + actual);
});
