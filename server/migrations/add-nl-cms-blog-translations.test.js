/**
 * The Dutch for the website blog. Pins the silent failure modes: an English
 * cms_blog key without Dutch leaves English on a Dutch screen (or a Dutch blog
 * page), a Dutch key without an English one is never read.
 *
 * Run: node --test migrations/add-nl-cms-blog-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256, applyNl } = require('./add-nl-cms-blog-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English cms_blog key has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const missing = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('cms_blog.') && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(missing, []);
});

test('the visitor labels of the public blog all have Dutch', () => {
    const pub = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('cms_blog.public.'));
    assert.ok(pub.length >= 15);
    for (const k of pub) assert.ok(NL_TRANSLATIONS[k] || SAME_AS_ENGLISH.includes(k), k);
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'cms_blog.list.new': 'Nieuw stuk' });
    assert.strictEqual(own.merged['cms_blog.list.new'], 'Nieuw stuk');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});

test('the pinned data hash matches the data file', () => {
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'cms-blog-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual, `set DATA_SHA256 to ${actual}`);
});
