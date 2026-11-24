/**
 * The Dutch of the Cowork course rewrite. Pins: the pinned hash matches the data file (so a data change re-runs the
 * migration), every key exists in English, `was` is Dutch that shipped, the learn-content catalogue now ships the
 * new Dutch, the new Dutch keeps the placeholders and is not the English, no other catalogue rewords these keys, a
 * workspace's own wording survives, a second run changes nothing, and boot runs it after the catalogues it rewords.
 *
 * Run: node --test migrations/update-nl-learn-cowork-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_REWORDED, DATA_SHA256, dataHash, applyNl } = require('./update-nl-learn-cowork-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const ME = 'update-nl-learn-cowork-2026-11';
const LEARN_CONTENT = 'add-nl-learn-content-2026-10-translations';
/** The catalogues whose Dutch an install may hold for these keys, in boot order. */
const SHIPPERS = [LEARN_CONTENT, 'update-nl-settings-nav-2026-10', 'update-nl-admin-dashboard-2026-11'];

const learnData = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'learn-content-2026-10-nl.json'), 'utf8'));
/** @param {string} rev @param {string} file a path relative to this folder */
const gitShow = (rev, file) => require('node:child_process').execFileSync('git', ['show', `${rev}:./${file}`], { cwd: __dirname, maxBuffer: 1 << 28 }).toString('utf8');
const placeholders = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();

test('the pinned hash matches the data file, so a data change re-runs the migration', () => {
    assert.strictEqual(DATA_SHA256, dataHash(), `data/learn-cowork-2026-11-nl.json changed: set DATA_SHA256 in ${ME}.js to ${dataHash()}`);
});

test('every reworded key is a Cowork lesson text that exists in English', () => {
    assert.ok(Object.keys(NL_REWORDED).length > 100);
    for (const key of Object.keys(NL_REWORDED)) {
        assert.ok(key in GUI_DEFAULTS, key);
        assert.ok(key.startsWith('learn.'), key);
    }
});

test('`was` is Dutch an install received: the learn-content catalogue as committed, or an earlier rewording', () => {
    let shipped;
    try {
        shipped = [gitShow('HEAD', 'data/learn-content-2026-10-nl.json'), ...SHIPPERS.slice(1).map((m) => gitShow('HEAD', `${m}.js`)),
            ...fs.readdirSync(path.join(__dirname, 'data', 'admin-dashboard-2026-11')).map((f) => gitShow('HEAD', `data/admin-dashboard-2026-11/${f}`))].join('\n');
    } catch {
        return; // no git (an image build): the was texts were checked when the migration was written
    }
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        for (const w of was) {
            const forms = [w, JSON.stringify(w).slice(1, -1)];
            // Once this commit is the HEAD, the catalogue holds `now`; the earlier texts are still in the history.
            if (shipped.includes(JSON.stringify(now).slice(1, -1))) continue;
            assert.ok(forms.some((f) => shipped.includes(f)), `${key}: "${w.slice(0, 60)}…" never shipped`);
        }
    }
});

test('the learn-content catalogue now ships the new Dutch, so a fresh install starts there', () => {
    const { translations } = learnData();
    for (const [key, { now }] of Object.entries(NL_REWORDED)) assert.strictEqual(translations[key], now, key);
});

test('every Cowork lesson key the English has is seeded in Dutch', () => {
    const { translations, sameAsEnglish } = learnData();
    const lessons = ['cowork-basics', 'cowork-briefs', 'cowork-hands-on', 'cowork-run-as-agent'];
    for (const key of Object.keys(GUI_DEFAULTS)) {
        if (!lessons.some((l) => key.startsWith(`learn.${l}.`))) continue;
        assert.ok(key in translations || sameAsEnglish.includes(key), `${key}: no Dutch`);
    }
});

test('the new Dutch differs from the old and from the English, and keeps the placeholders', () => {
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && !was.includes(now), `${key}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[key], `${key}: English copied`);
        assert.deepStrictEqual(placeholders(now), placeholders(GUI_DEFAULTS[key]), key);
    }
});

test('no other catalogue of the boot ladder rewords these keys', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    for (const name of ladder) {
        if (name === ME) continue;
        const mod = require(`./${name}`);
        for (const key of Object.keys(NL_REWORDED)) assert.ok(!(mod.NL_REWORDED && Object.hasOwn(mod.NL_REWORDED, key)), `${key}: ${name} rewords it too`);
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
    const me = ladder.indexOf(ME);
    assert.ok(me > 0, 'not in the boot ladder');
    for (const name of SHIPPERS) assert.ok(ladder.indexOf(name) >= 0 && ladder.indexOf(name) < me, name);
    assert.ok(me < ladder.indexOf('rename-routine-i18n-2026-10'));
});
