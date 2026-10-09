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

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, up } = require('./add-nl-hardcoded-studio-admin-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// Namespaces that exist only because of this conversion, so every English key
// under them must have Dutch here (or be declared identical).
const OWNED_PREFIXES = [
    'studio_apps_bi.', 'studio_apps_edit.', 'studio_apps_tables.', 'studio_apps_insp.',
    'studio_apps_panels.', 'studio_apps_runtime.', 'studio_misc.',
];

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no key is both translated and declared identical', () => {
    const both = SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS);
    assert.deepStrictEqual(both, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated; if the Dutch really is the English, move it to SAME_AS_ENGLISH`);
    }
});

test('every English key in the Studio namespaces has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
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

test('no other Dutch catalogue seeds these keys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-hardcoded-studio-admin-2026-10-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-hardcoded-studio-admin-2026-10-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
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
