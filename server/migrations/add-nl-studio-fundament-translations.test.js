/**
 * A Dutch key that matches no English key is stored, never read, and the UI
 * quietly stays English — with no error anywhere. And a shared-chrome key
 * WITHOUT a Dutch value is a capsule that says "Entire organisation" on a
 * screen where every other word is Dutch, on the one control that widens who
 * sees the data. Both failure modes are silent, so both are pinned here.
 *
 * Run: node --test migrations/add-nl-studio-fundament-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-studio-fundament-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The Track 0 shared-chrome keys. `studio.*` as a whole is older than this
// migration (studio.tab.*, studio.sidebar_link ship elsewhere), so the scope
// is the sub-namespaces the shared primitives own, plus the two namespaces
// they introduced.
const OWNED_PREFIXES = [
    'studio.status.', 'studio.category.', 'studio.locked_', 'studio.new.', 'studio.header.',
    'visibility.',
];
// usage.* is shared with the older Usage & Monitoring page; only the keys the
// UsedByTab / DangerZone primitives read belong here.
const OWNED_USAGE = /^usage\.(loading|error|empty|table_label|head_|pill_|someone_elses|untitled_kind|role_|kind_|delete_|checking|in_use_refreshed|err_delete|cancel)/;

// English keys that stay in the dictionaries under the never-rename rule but
// that no component reads any more: the Studio categories became
// build / ai / bundle / modules and 'development' went with the rename.
// Seeding Dutch for a dead key is a translation nobody will ever see.
const RETIRED = new Set(['studio.category.development']);

// Keys under an owned prefix that a LATER, dedicated catalogue seeds. One key,
// one owner: addMissingGUITranslations keeps whichever value lands first, so a
// second seed here would let boot order decide the wording. Each entry names
// its owner and a test below checks the owner really declares the key — an
// entry here is a claim that can go red, not an escape hatch.
const OWNED_ELSEWHERE = new Map([
    ['studio.new.playbook', './add-nl-playbooks-translations'],
    ['studio.locked_training', './add-nl-learning-center-translations'],
]);

function owned(key) {
    if (RETIRED.has(key) || OWNED_ELSEWHERE.has(key)) return false;
    return OWNED_PREFIXES.some(p => key.startsWith(p)) || OWNED_USAGE.test(key);
}

test('a retired key is seeded in neither list', () => {
    for (const k of RETIRED) {
        assert.ok(!(k in NL_TRANSLATIONS), `${k} is retired — no component reads it, drop the Dutch`);
        assert.ok(!SAME_AS_ENGLISH.includes(k), `${k} is retired — do not declare it identical either`);
    }
});

test('a key owned elsewhere is really seeded there — and not here as well', () => {
    for (const [k, owner] of OWNED_ELSEWHERE) {
        const cat = require(owner);
        assert.ok(k in cat.NL_TRANSLATIONS || (cat.SAME_AS_ENGLISH || []).includes(k),
            `${k}: ${owner} no longer seeds it — translate it here, or fix the claim`);
        assert.ok(!(k in NL_TRANSLATIONS) && !SAME_AS_ENGLISH.includes(k),
            `${k} is seeded here too — boot order would decide the wording`);
    }
});

test('a key is either translated or declared identical, never both', () => {
    const both = SAME_AS_ENGLISH.filter(k => k in NL_TRANSLATIONS);
    assert.deepStrictEqual(both, []);
});

test('every English shared-chrome key has a Dutch one (or is declared identical)', () => {
    // The direction that decides whether a Dutch user sees Dutch. A missing key
    // is not an error anywhere: t() falls back to English and the screen looks
    // fine to whoever wrote it. The publish capsule and the danger zone are
    // consent surfaces, so half-translated is the outcome worth failing on.
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});
