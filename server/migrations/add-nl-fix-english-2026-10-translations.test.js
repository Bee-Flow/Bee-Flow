/**
 * Dutch for keys that still read English (2026-10): every key exists in English and differs from it, placeholders
 * survive, a shipped English value is replaced, a workspace's own wording is kept, it is registered, and a data
 * change re-runs it.
 *
 * Run: node --test migrations/add-nl-fix-english-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_FIXES, DATA_SHA256, applyNl, up } = require('./add-nl-fix-english-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every key exists in the English catalog and its Dutch differs from the English', () => {
    for (const [k, v] of Object.entries(NL_FIXES)) {
        assert.ok(k in GUI_DEFAULTS, `${k} has no English counterpart`);
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} is the English text; a fix that fixes nothing`);
    }
});

test('placeholders and ICU plural/select blocks survive translation', () => {
    const holes = (s) => (String(s).match(/\{\{?[a-z_][a-z0-9_.]*\}?\}/gi) || []).sort();
    const icu = (s) => (String(s).match(/\{\s*\w+\s*,\s*(plural|select)/g) || []).length;
    for (const [k, v] of Object.entries(NL_FIXES)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
        assert.strictEqual(icu(v), icu(GUI_DEFAULTS[k]), `${k}: plural/select structure differs from English`);
    }
});

test('a missing key and a shipped English value are set; a workspace\'s own wording is kept', () => {
    const [first, second] = Object.keys(NL_FIXES);
    const r = applyNl({ [first]: GUI_DEFAULTS[first], [second]: 'Eigen woorden' }, GUI_DEFAULTS);
    assert.strictEqual(r.merged[first], NL_FIXES[first], 'the English default is a shipped value, replaced');
    assert.strictEqual(r.merged[second], 'Eigen woorden', 'a curated value is kept');
    assert.strictEqual(r.changed, Object.keys(NL_FIXES).length - 1, 'every other key was missing and is set');
    for (const k of Object.keys(NL_FIXES)) if (k !== second) assert.strictEqual(r.merged[k], NL_FIXES[k]);
});

test('a second run changes nothing', () => {
    const first = applyNl({}, GUI_DEFAULTS);
    const second = applyNl({ ...first.merged }, GUI_DEFAULTS);
    assert.strictEqual(second.changed, 0);
    assert.deepStrictEqual(second.merged, first.merged);
});

test('the migration is registered after the catalogues it corrects, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    const at = bootList.indexOf('add-nl-fix-english-2026-10-translations');
    assert.ok(at >= 0, 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    // every catalogue that owns one of these keys must have run first, or its English would win on a fresh database
    const owners = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^(add|update)-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f.startsWith('add-nl-fix-english')) continue;
        let other;
        try { other = require(path.join(__dirname, f)); } catch { continue; }
        const keys = [...Object.keys(other?.NL_TRANSLATIONS ?? {}), ...(other?.SAME_AS_ENGLISH ?? [])];
        if (keys.some((k) => k in NL_FIXES)) owners.push(f.replace(/\.js$/, ''));
    }
    for (const o of owners) {
        const i = bootList.indexOf(o);
        assert.ok(i < 0 || i < at, `${o} owns one of these keys and must run before the fix`);
    }
    assert.strictEqual(typeof up, 'function');
});

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const actual = sha256Of(path.join(__dirname, 'data', 'fix-english-2026-10-nl.json'));
    assert.strictEqual(DATA_SHA256, actual, 'data/fix-english-2026-10-nl.json changed: set DATA_SHA256 in add-nl-fix-english-2026-10-translations.js to ' + actual);
});
