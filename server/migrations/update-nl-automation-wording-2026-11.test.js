/**
 * The Dutch of the automation wording round. Pins: every reworded key exists
 * in English, `was` is the Dutch that really shipped (so existing installs
 * match it), the new Dutch keeps the placeholders and is not the English, a
 * workspace's own wording survives, a second run changes nothing, and boot
 * runs it after the catalogues whose Dutch it rewords.
 *
 * Run: node --test migrations/update-nl-automation-wording-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_REWORDED, applyNl } = require('./update-nl-automation-wording-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/** The catalogue that shipped each key's old Dutch. */
const SHIPPED_BY = {
    'automations.assistant.mode.right_away_hint': 'add-nl-builder-fixes-2026-10',
    'automation_testing.header.run_live': 'add-nl-automation-testing-translations',
    'studio_misc.menu.view_runs': 'add-nl-hardcoded-studio-admin-2026-10-translations',
    'studio_misc.menu.export_json': 'add-nl-hardcoded-studio-admin-2026-10-translations',
    'automations.library.deleteTitle': 'add-nl-builder-handoff5-translations',
    'automations.repeating.personalData': 'add-nl-repeating-work-translations',
};
const placeholders = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();

test('the reworded keys are exactly the six whose English changed, and each exists in English', () => {
    assert.deepStrictEqual(Object.keys(NL_REWORDED).sort(), Object.keys(SHIPPED_BY).sort());
    for (const key of Object.keys(NL_REWORDED)) assert.ok(key in GUI_DEFAULTS, key);
});

test('`was` is the Dutch that shipped, so existing installs match it', () => {
    for (const [key, { was }] of Object.entries(NL_REWORDED)) {
        const shipped = require(`./${SHIPPED_BY[key]}`).NL_TRANSLATIONS[key];
        assert.ok(shipped && was.includes(shipped), `${key}: shipped ${JSON.stringify(shipped)}`);
    }
});

test('the new Dutch differs from the old and from the English, keeps the placeholders and uses no dash', () => {
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && !was.includes(now), `${key}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[key], `${key}: English copied`);
        assert.deepStrictEqual(placeholders(now), placeholders(GUI_DEFAULTS[key]), key);
        assert.ok(!/[–—]/.test(now) && !/[–—]/.test(GUI_DEFAULTS[key]), `${key}: a dash as punctuation`);
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
    const me = ladder.indexOf('update-nl-automation-wording-2026-11');
    assert.ok(me > 0, 'not in the boot ladder');
    for (const name of new Set(Object.values(SHIPPED_BY))) assert.ok(ladder.indexOf(name) >= 0 && ladder.indexOf(name) < me, name);
    assert.ok(me < ladder.indexOf('rename-routine-i18n-2026-10'));
});
