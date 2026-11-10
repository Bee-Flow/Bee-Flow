/**
 * The Dutch for setting up and testing Teams meeting notes. Pins the silent
 * failure modes: an English teams_setup key without Dutch leaves English on a
 * Dutch screen, a Dutch key without an English one is never read, and a
 * placeholder lost in translation shows a raw {brace} or drops the value.
 * (The generic rules run for every catalogue in nlCatalogues.test.js.)
 *
 * Run: node --test migrations/add-nl-teams-setup-2026-11-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-teams-setup-2026-11-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');

const holes = (s) => (String(s).match(/\{\{?[a-z0-9_][a-z0-9_.]*\}?\}/gi) || []).sort();

test('every English teams_setup key has Dutch (or is declared identical), and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('teams_setup.'));
    assert.ok(english.length >= 280, `only ${english.length} teams_setup keys`);
    const covered = new Set([...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH]);
    assert.deepStrictEqual(english.filter((k) => !covered.has(k)), []);
    assert.deepStrictEqual([...covered].filter((k) => !(k in GUI_DEFAULTS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !k.startsWith('teams_setup.')), [], 'this catalogue owns teams_setup only');
});

test('placeholders are identical to the English', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ`);
    }
});

test('no em dash in the Dutch', () => {
    assert.deepStrictEqual(Object.entries(NL_TRANSLATIONS).filter(([, v]) => v.includes('—')).map(([k]) => k), []);
});

test('no other add-nl catalogue seeds a teams_setup key: one key, one owner', () => {
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-teams-setup-2026-11-translations.js') continue;
        let table;
        try { table = require(`./${f}`).NL_TRANSLATIONS; } catch { table = null; }
        if (!table || typeof table !== 'object') continue;
        for (const k of Object.keys(table)) if (k.startsWith('teams_setup.')) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, []);
});

test('it runs at boot', () => {
    assert.ok(BOOT_LIST.includes('add-nl-teams-setup-2026-11-translations'));
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({ 'teams_setup.status.pass': 'Eigen tekst' });
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length - 1);
    assert.strictEqual(merged['teams_setup.status.pass'], 'Eigen tekst');
    assert.strictEqual(applyNl(merged).added, 0);
    for (const k of SAME_AS_ENGLISH) assert.ok(!(k in merged), `${k} is declared identical and must not be seeded`);
});
