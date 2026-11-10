/**
 * The one catalogue that seeds server/i18n/defaults/nl/<namespace>.json. The
 * generic rules (English counterpart, placeholders, no copied English, one
 * owner per key) run in nlCatalogues.test.js; this file pins what is specific:
 * it seeds what the data files hold, it fills only missing keys, and its
 * ledger checksum moves with the data files while every other entry's stays
 * the sha256 of its own file.
 *
 * Run: node --test migrations/add-nl-namespace-files.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-namespace-files');
const { loadNamespaceFiles, sourceHash } = require('../i18n/defaults/nl');
const { checksumOf } = require('../boot/migrationChecksum');
const { NL_TRANSLATIONS: LADDER, LOOSE_MIGRATIONS } = require('../boot/bootMigrations');

const sha = (/** @type {Buffer | string} */ b) => crypto.createHash('sha256').update(b).digest('hex');

test('it seeds exactly what the data files hold', () => {
    const loaded = loadNamespaceFiles();
    assert.deepStrictEqual({ ...NL_TRANSLATIONS }, loaded.translations);
    assert.deepStrictEqual([...SAME_AS_ENGLISH], loaded.sameAsEnglish);
    assert.ok(NL_TRANSLATIONS['studio_apps_schema.newer_than_install'], 'the App Studio schema namespace is seeded');
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, { ...NL_TRANSLATIONS });
    const [first] = Object.keys(NL_TRANSLATIONS);
    const own = applyNl({ [first]: 'Eigen woord' });
    assert.strictEqual(own.merged[first], 'Eigen woord');
    const again = applyNl({ ...merged });
    assert.strictEqual(again.added, 0);
    assert.deepStrictEqual(again.merged, merged);
});

test('the boot ladder runs it, after every other Dutch catalogue', () => {
    assert.strictEqual(LADDER[LADDER.length - 1], 'add-nl-namespace-files');
});

test('its ledger checksum covers the data files, so a new or changed file runs it again', () => {
    const own = fs.readFileSync(path.join(__dirname, 'add-nl-namespace-files.js'));
    const want = crypto.createHash('sha256').update(own).update(`\0${sourceHash()}`).digest('hex');
    assert.strictEqual(checksumOf('add-nl-namespace-files'), want);
    assert.notStrictEqual(checksumOf('add-nl-namespace-files'), sha(own));
});

test('every other entry\'s checksum is still the sha256 of its own file, so nothing already recorded runs again', () => {
    for (const name of [...LOOSE_MIGRATIONS, ...LADDER]) {
        if (name === 'add-nl-namespace-files') continue;
        assert.strictEqual(checksumOf(name), sha(fs.readFileSync(path.join(__dirname, `${name}.js`))), name);
    }
});
