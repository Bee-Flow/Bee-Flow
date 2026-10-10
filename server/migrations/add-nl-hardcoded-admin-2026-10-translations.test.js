/**
 * The Dutch for the admin screens that had hard-coded English (2026-10).
 * A Dutch key without an English counterpart is stored and never read; an
 * English key without Dutch leaves one English sentence in a Dutch screen.
 *
 * Run: node --test migrations/add-nl-hardcoded-admin-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-hardcoded-admin-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIXES = ['admin_subscriptions.', 'admin_org.', 'admin_ai_config.', 'admin_monitoring.', 'admin_languages.', 'admin_security.', 'admin_shared.'];

const OWNED_ELSEWHERE = new Set();

test('every English key in the admin namespaces has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)) && !OWNED_ELSEWHERE.has(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('no dashes as punctuation in the new text, in either language', () => {
    // The decorative picker labels "— Use the fast tier —" are the one exception: existing tests pin them.
    const decorative = (x) => /^— .* —$/.test(x);
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        if (decorative(v)) continue;
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
        assert.ok(!/[–—]/.test(GUI_DEFAULTS[k]), `${k} (en) uses a dash`);
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

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { DATA_SHA256 } = require('./add-nl-hardcoded-admin-2026-10-translations');
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'hardcoded-admin-2026-10-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/hardcoded-admin-2026-10-nl.json changed: set DATA_SHA256 in add-nl-hardcoded-admin-2026-10-translations.js to ' + actual
        + ' so installs that already ran this migration run it again');
});
