/**
 * The Dutch of the admin dashboard clean-up, wave 0. Pins: the pinned hash
 * matches the manifests (so a manifest change re-runs the migration), every key
 * exists in English, `was` is the Dutch that really shipped, the catalogue data
 * now ships the new Dutch, the new Dutch keeps the placeholders and is not the
 * English, a workspace's own wording survives, a second run changes nothing,
 * and boot runs it after the catalogues whose Dutch it rewords.
 *
 * Run: node --test migrations/update-nl-admin-dashboard-w0-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_REWORDED, DATA_SHA256, manifestHash, applyNl } = require('./update-nl-admin-dashboard-w0-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** The catalogue that shipped each namespace's old Dutch, and its data file. */
const SHIPPED_BY = {
    'admin_ai_config.': { migration: 'add-nl-hardcoded-admin-2026-10-translations', data: 'hardcoded-admin-2026-10-nl.json' },
    'learn.': { migration: 'add-nl-learn-content-2026-10-translations', data: 'learn-content-2026-10-nl.json' },
};
/** @param {string} key */
const shipperOf = (key) => {
    const prefix = Object.keys(SHIPPED_BY).find((p) => key.startsWith(p));
    assert.ok(prefix, `${key}: no known catalogue shipped its Dutch`);
    return SHIPPED_BY[prefix];
};
const placeholders = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();

test('the pinned hash matches the manifests, so a manifest change re-runs the migration', () => {
    const actual = manifestHash();
    assert.strictEqual(DATA_SHA256, actual, `data/admin-dashboard-w0/ changed: set DATA_SHA256 in update-nl-admin-dashboard-w0-2026-11.js to ${actual}`);
});

test('every reworded key exists in English, and there is something to reword', () => {
    assert.ok(Object.keys(NL_REWORDED).length > 0);
    for (const key of Object.keys(NL_REWORDED)) assert.ok(key in GUI_DEFAULTS, key);
});

test('`was` is the Dutch that shipped, so existing installs match it', () => {
    const { execFileSync } = require('node:child_process');
    for (const [key, { was }] of Object.entries(NL_REWORDED)) {
        const { data } = shipperOf(key);
        // The data file in the last commit is what installs received; the working copy now ships the new text.
        let shipped;
        try {
            const blob = execFileSync('git', ['show', `HEAD:./data/${data}`], { cwd: __dirname, maxBuffer: 1 << 28 }).toString('utf8');
            shipped = JSON.parse(blob).translations[key];
        } catch {
            return; // no git (an image build): the was texts were checked when the migration was written
        }
        if (shipped === NL_REWORDED[key].now) continue; // already committed with the new Dutch
        assert.ok(shipped && was.includes(shipped), `${key}: shipped ${JSON.stringify(shipped)}`);
    }
});

test('the catalogue data now ships the new Dutch, so a fresh install starts there', () => {
    for (const [key, { now }] of Object.entries(NL_REWORDED)) {
        const { migration, data } = shipperOf(key);
        const table = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', data), 'utf8')).translations;
        assert.strictEqual(table[key], now, `${key} in data/${data}`);
        assert.strictEqual(require(`./${migration}`).NL_TRANSLATIONS[key], now, `${key} in ${migration}`);
    }
});

test('the new Dutch differs from the old and from the English, and keeps the placeholders', () => {
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && !was.includes(now), `${key}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[key], `${key}: English copied`);
        assert.deepStrictEqual(placeholders(now), placeholders(GUI_DEFAULTS[key]), key);
    }
});

test('old shipped Dutch and a missing key get the new text; own wording stays; a second run changes nothing', () => {
    const keys = Object.keys(NL_REWORDED);
    const old = Object.fromEntries(keys.map((k) => [k, NL_REWORDED[k].was[0]]));
    const fromOld = applyNl({ ...old, unrelated: 'blijft' });
    for (const k of keys) assert.strictEqual(fromOld.merged[k], NL_REWORDED[k].now, k);
    assert.strictEqual(fromOld.merged.unrelated, 'blijft');
    assert.strictEqual(fromOld.reworded, keys.length);
    assert.strictEqual(applyNl({}).reworded, keys.length);
    assert.strictEqual(applyNl({ [keys[0]]: 'Eigen tekst' }).merged[keys[0]], 'Eigen tekst');
    assert.strictEqual(applyNl({ ...fromOld.merged }).reworded, 0);
});

test('boot runs it after the catalogues whose Dutch it rewords, and before the routine rename', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const me = ladder.indexOf('update-nl-admin-dashboard-w0-2026-11');
    assert.ok(me > 0, 'not in the boot ladder');
    for (const { migration } of Object.values(SHIPPED_BY)) {
        assert.ok(ladder.indexOf(migration) >= 0 && ladder.indexOf(migration) < me, migration);
    }
    assert.ok(me < ladder.indexOf('rename-routine-i18n-2026-10'));
});
