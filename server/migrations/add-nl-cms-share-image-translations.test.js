/**
 * The Dutch for the share image setting. Pins the silent failure modes: an English
 * cms_share key without Dutch leaves English on a Dutch screen, a Dutch key
 * without an English one is never read.
 *
 * Run: node --test migrations/add-nl-cms-share-image-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256, applyNl } = require('./add-nl-cms-share-image-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English cms_share key has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('cms_share.') && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(missing, []);
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'cms_share.title': 'Eigen woorden' });
    assert.strictEqual(own.merged['cms_share.title'], 'Eigen woorden');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});

test('the pinned data hash matches the data file', () => {
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'cms-share-image-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual, `set DATA_SHA256 in add-nl-cms-share-image-translations.js to ${actual}`);
});
