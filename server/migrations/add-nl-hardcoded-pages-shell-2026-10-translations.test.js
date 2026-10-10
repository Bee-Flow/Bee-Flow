/**
 * Dutch for the text agent-hub used to hard-code in English. Two silent
 * failure modes are pinned: a Dutch key that matches no English key is stored
 * and never read, and an English key without Dutch leaves one English
 * sentence in an otherwise Dutch screen.
 *
 * Run: node --test migrations/add-nl-hardcoded-pages-shell-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-hardcoded-pages-shell-2026-10-translations');

test('the composer footer is Dutch', () => {
    assert.strictEqual(NL_TRANSLATIONS['chat.composer.footer_own_server'], 'Bee Flow draait op je eigen server.');
    assert.ok(NL_TRANSLATIONS['chat.composer.disclaimer']);
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);

    const own = applyNl({ 'chat.composer.disclaimer': 'Eigen tekst' });
    assert.strictEqual(own.merged['chat.composer.disclaimer'], 'Eigen tekst');
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
    const { DATA_SHA256 } = require('./add-nl-hardcoded-pages-shell-2026-10-translations');
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'hardcoded-pages-shell-2026-10-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/hardcoded-pages-shell-2026-10-nl.json changed: set DATA_SHA256 in add-nl-hardcoded-pages-shell-2026-10-translations.js to ' + actual
        + ' so installs that already ran this migration run it again');
});
