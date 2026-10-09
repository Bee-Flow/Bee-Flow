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

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, up } = require('./add-nl-hardcoded-pages-shell-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

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

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

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

test('no other Dutch catalogue seeds these keys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-hardcoded-pages-shell-2026-10-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-hardcoded-pages-shell-2026-10-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
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
