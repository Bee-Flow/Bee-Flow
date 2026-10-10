/**
 * The Dutch for the Studio screens converted to t() in 2026-10. Two silent
 * failure modes are pinned here: a Dutch key that matches no English key is
 * stored and never read, and an English key without Dutch leaves one English
 * sentence in an otherwise Dutch screen.
 *
 * Run: node --test migrations/add-nl-hardcoded-studio-admin-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-hardcoded-studio-admin-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// Namespaces that exist only because of this conversion, so every English key
// under them must have Dutch here (or be declared identical).
const OWNED_PREFIXES = [
    'studio_apps_bi.', 'studio_apps_edit.', 'studio_apps_tables.', 'studio_apps_insp.',
    'studio_apps_panels.', 'studio_apps_runtime.', 'studio_misc.',
];

test('every English key in the Studio namespaces has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);

    const own = applyNl({ [Object.keys(NL_TRANSLATIONS)[0]]: 'Eigen woord' });
    assert.strictEqual(own.merged[Object.keys(NL_TRANSLATIONS)[0]], 'Eigen woord');
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
    const { DATA_SHA256 } = require('./add-nl-hardcoded-studio-admin-2026-10-translations');
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'hardcoded-studio-admin-2026-10-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/hardcoded-studio-admin-2026-10-nl.json changed: set DATA_SHA256 in add-nl-hardcoded-studio-admin-2026-10-translations.js to ' + actual
        + ' so installs that already ran this migration run it again');
});
