/**
 * The Dutch for the phone-friendly 2FA setup screen (BFSF-280): every key
 * matches an English one, and the reworded `mfa.required_desc` replaces only
 * the text an earlier catalogue seeded, never a workspace's own wording.
 *
 * Run: node --test migrations/add-nl-mfa-setup-mobile-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl, up } = require('./add-nl-mfa-setup-mobile-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const ALL_NL = { ...NL_TRANSLATIONS, ...Object.fromEntries(Object.entries(NL_REWORDED).map(([k, v]) => [k, v.now])) };

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(ALL_NL).filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(ALL_NL)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

test('no dashes as punctuation in the new text, in either language', () => {
    for (const [k, v] of Object.entries(ALL_NL)) {
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
        assert.ok(!/[–—]/.test(GUI_DEFAULTS[k]), `${k} (en) uses a dash`);
    }
});

test('the reworded description no longer blames an administrator, in either language', () => {
    assert.ok(!/administrator/i.test(GUI_DEFAULTS['mfa.required_desc']));
    assert.ok(!/beheerder/i.test(NL_REWORDED['mfa.required_desc'].now));
});

test('a blob without the keys gets all of them', () => {
    const { merged, added, reworded } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.strictEqual(reworded, 1);
    assert.deepStrictEqual(merged, ALL_NL);
});

test('the seeded description is reworded, a workspace\'s own wording is kept', () => {
    const seeded = applyNl({ 'mfa.required_desc': NL_REWORDED['mfa.required_desc'].was });
    assert.strictEqual(seeded.merged['mfa.required_desc'], NL_REWORDED['mfa.required_desc'].now);

    const own = 'Onze eigen zin over tweestapsverificatie.';
    const custom = applyNl({ 'mfa.required_desc': own, 'mfa.setup_intro': 'Eigen uitleg.' });
    assert.strictEqual(custom.merged['mfa.required_desc'], own);
    assert.strictEqual(custom.merged['mfa.setup_intro'], 'Eigen uitleg.');
    assert.strictEqual(custom.reworded, 0);
});

test('a second run changes nothing', () => {
    const first = applyNl({});
    const second = applyNl({ ...first.merged });
    assert.strictEqual(second.added, 0);
    assert.strictEqual(second.reworded, 0);
    assert.deepStrictEqual(second.merged, first.merged);
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-mfa-setup-mobile-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    // After the catalogue that seeded the old text, so a fresh install ends on the new one.
    assert.ok(bootList.indexOf('add-nl-mfa-setup-mobile-translations') > bootList.indexOf('add-nl-signup-mfa-reset-auth-translations'));
    assert.strictEqual(typeof up, 'function');
});
