/**
 * The Dutch of the document sharing dialog. Pins: the reworded key exists in
 * English, `was` is the Dutch that really shipped (so existing installs match
 * it), the new Dutch names reading AND editing like the English, keeps the
 * placeholders and is not the English, a workspace's own wording survives, a
 * second run changes nothing, and boot runs it after the catalogue whose
 * Dutch it rewords.
 *
 * Run: node --test migrations/update-nl-document-sharing-2026-11.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_REWORDED, applyNl } = require('./update-nl-document-sharing-2026-11');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const SHIPPED_BY = 'add-nl-document-sharing-translations';
const placeholders = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();

test('the reworded key is the one whose English changed, and it exists in English', () => {
    assert.deepStrictEqual(Object.keys(NL_REWORDED), ['documents.sharing.read_access']);
    assert.match(GUI_DEFAULTS['documents.sharing.read_access'], /also edit/);
});

test('`was` is the Dutch that shipped, so existing installs match it', () => {
    const shipped = require(`./${SHIPPED_BY}`).NL_TRANSLATIONS;
    for (const [key, { was }] of Object.entries(NL_REWORDED)) assert.ok(was.includes(shipped[key]), key);
});

test('the new Dutch offers reading and editing, differs from the old and the English, keeps the placeholders', () => {
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && !was.includes(now), `${key}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[key], `${key}: English copied`);
        assert.deepStrictEqual(placeholders(now), placeholders(GUI_DEFAULTS[key]), key);
        assert.ok(!/[–—]/.test(now), `${key}: a dash as punctuation`);
    }
    assert.match(NL_REWORDED['documents.sharing.read_access'].now, /lezen/);
    assert.match(NL_REWORDED['documents.sharing.read_access'].now, /bewerken/);
});

test('the rest of the shipped sharing Dutch still matches its English: nothing else needs rewording', () => {
    const shipped = require(`./${SHIPPED_BY}`).NL_TRANSLATIONS;
    for (const key of Object.keys(shipped)) {
        assert.ok(key in GUI_DEFAULTS, `${key}: gone from English`);
        assert.deepStrictEqual(placeholders(shipped[key]), placeholders(GUI_DEFAULTS[key]), key);
    }
});

test('old shipped Dutch and a missing key get the new text; own wording stays; a second run changes nothing', () => {
    const key = 'documents.sharing.read_access';
    const fromOld = applyNl({ [key]: NL_REWORDED[key].was[0], unrelated: 'blijft' });
    assert.strictEqual(fromOld.merged[key], NL_REWORDED[key].now);
    assert.strictEqual(fromOld.merged.unrelated, 'blijft');
    assert.strictEqual(fromOld.reworded, 1);
    assert.strictEqual(applyNl({}).reworded, 1);
    assert.strictEqual(applyNl({ [key]: 'Eigen tekst' }).merged[key], 'Eigen tekst');
    assert.strictEqual(applyNl({ ...fromOld.merged }).reworded, 0);
});

test('boot runs it after the catalogue whose Dutch it rewords, and before the routine rename', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const me = ladder.indexOf('update-nl-document-sharing-2026-11');
    assert.ok(me > 0, 'not in the boot ladder');
    assert.ok(ladder.indexOf(SHIPPED_BY) >= 0 && ladder.indexOf(SHIPPED_BY) < me);
    assert.ok(me < ladder.indexOf('rename-routine-i18n-2026-10'));
});
