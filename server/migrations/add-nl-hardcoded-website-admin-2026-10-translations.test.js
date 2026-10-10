/**
 * Dutch for the website admin and the Component Studio. Two silent failure
 * modes are pinned here: a Dutch key that matches no English key is stored and
 * never read, and an English key without Dutch leaves one English sentence in
 * an otherwise Dutch screen.
 *
 * Run: node --test migrations/add-nl-hardcoded-website-admin-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, DATA_SHA256 } = require('./add-nl-hardcoded-website-admin-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// Namespaces that exist only because of this round: every English key under
// them must have Dutch here (or be declared identical).
const OWNED_PREFIXES = ['cms_site.', 'component_studio.'];

test('every English key in the owned namespaces has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('the Dutch addresses the reader as je, never u', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/(?<![}\d])\b(u|uw)\b/i.test(v), `${k}: use je/jouw`);
    }
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);

    const first = Object.keys(NL_TRANSLATIONS)[0];
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
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'hardcoded-website-admin-2026-10-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/hardcoded-website-admin-2026-10-nl.json changed: set DATA_SHA256 in add-nl-hardcoded-website-admin-2026-10-translations.js to ' + actual);
});
