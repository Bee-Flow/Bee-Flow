/**
 * The Dutch for the Tabs block and customer stories. Pins the silent failure modes: an English
 * key without Dutch leaves English on a Dutch screen (or a Dutch page), a Dutch key without an English one is never read.
 *
 * Run: node --test migrations/add-nl-cms-tabs-stories-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256, applyNl } = require('./add-nl-cms-tabs-stories-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED = /^cms_site\.blocks\.(tabs|story_header|customer_stories)\./;

test('every English key this catalogue owns has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => OWNED.test(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(missing, []);
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'cms_site.blocks.tabs.tabs': 'Eigen tekst' });
    assert.strictEqual(own.merged['cms_site.blocks.tabs.tabs'], 'Eigen tekst');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});

test('the pinned data hash matches the data file', () => {
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'cms-tabs-stories-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual, `set DATA_SHA256 to ${actual}`);
});
