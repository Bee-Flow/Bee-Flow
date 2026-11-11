/**
 * The Dutch of the admin scope labels. Pins: every key exists in English, the
 * `was` texts are the Dutch that really shipped, the new Dutch keeps the
 * placeholders and is not the English, a workspace's own wording survives, a
 * second run changes nothing, and boot runs it after the catalogue whose Dutch
 * it rewords.
 *
 * Run: node --test migrations/update-nl-admin-scope-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl } = require('./update-nl-admin-scope-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const placeholders = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
const SHIPPED_FILE = path.join(__dirname, 'data', 'hardcoded-integrations-agents-2026-10-nl.json');
const LEARN_SHIPPED_FILE = path.join(__dirname, 'data', 'learn-content-2026-10-nl.json');

test('every key exists in English, has Dutch that is not the English, and keeps its placeholders', () => {
    for (const k of Object.keys(NL_TRANSLATIONS)) {
        assert.ok(k in GUI_DEFAULTS, k);
        assert.notStrictEqual(NL_TRANSLATIONS[k], GUI_DEFAULTS[k], `${k}: English copied`);
        assert.deepStrictEqual(placeholders(NL_TRANSLATIONS[k]), placeholders(GUI_DEFAULTS[k]), k);
    }
    for (const [k, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(k in GUI_DEFAULTS, k);
        assert.ok(!was.includes(now), `${k}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[k], `${k}: English copied`);
        assert.deepStrictEqual(placeholders(now), placeholders(GUI_DEFAULTS[k]), k);
    }
    assert.ok(!Object.keys(NL_TRANSLATIONS).some((k) => k in NL_REWORDED));
});

test('`was` is the Dutch that shipped, so existing installs match it', () => {
    const read = (file) => { const shipped = JSON.parse(fs.readFileSync(file, 'utf8')); return shipped.translations || shipped; };
    const table = { ...read(SHIPPED_FILE), ...read(LEARN_SHIPPED_FILE) };
    for (const [key, { was }] of Object.entries(NL_REWORDED)) {
        assert.ok(was.includes(table[key]), `${key}: shipped ${JSON.stringify(table[key])}`);
    }
});

test('old shipped Dutch and a missing key get the new text; own wording stays; a second run changes nothing', () => {
    const keys = Object.keys(NL_REWORDED);
    const old = Object.fromEntries(keys.map((k) => [k, NL_REWORDED[k].was[0]]));
    const first = applyNl({ ...old, unrelated: 'blijft' });
    for (const k of keys) assert.strictEqual(first.merged[k], NL_REWORDED[k].now, k);
    for (const k of Object.keys(NL_TRANSLATIONS)) assert.strictEqual(first.merged[k], NL_TRANSLATIONS[k], k);
    assert.strictEqual(first.merged.unrelated, 'blijft');
    assert.strictEqual(first.reworded, keys.length);
    assert.strictEqual(applyNl({ [keys[0]]: 'Eigen tekst' }).merged[keys[0]], 'Eigen tekst');
    const second = applyNl({ ...first.merged });
    assert.deepStrictEqual([second.added, second.reworded], [0, 0]);
});

test('boot runs it after the catalogue whose Dutch it rewords, and before the routine rename', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const me = ladder.indexOf('update-nl-admin-scope-2026-11');
    assert.ok(me > 0, 'not in the boot ladder');
    const shipper = ladder.indexOf('add-nl-hardcoded-integrations-agents-2026-10-translations');
    assert.ok(shipper >= 0 && shipper < me);
    const learnShipper = ladder.indexOf('add-nl-learn-content-2026-10-translations');
    assert.ok(learnShipper >= 0 && learnShipper < me);
    assert.ok(me < ladder.indexOf('rename-routine-i18n-2026-10'));
});
