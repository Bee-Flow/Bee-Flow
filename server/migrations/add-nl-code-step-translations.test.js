/**
 * The Dutch for the code step. Pins the two silent failures: a Dutch key that
 * matches no English key (stored, never read) and an English key without
 * Dutch (one English sentence in a Dutch screen), plus the data-hash pin.
 *
 * Run: node --test migrations/add-nl-code-step-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, DATA_SHA256 } = require('./add-nl-code-step-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('the pinned hash is the data file\'s, so a data change re-runs the migration', () => {
    const data = fs.readFileSync(path.join(__dirname, 'data', 'code-step-nl.json'));
    assert.strictEqual(crypto.createHash('sha256').update(data).digest('hex'), DATA_SHA256);
});

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('every code_step key has Dutch, or is declared identical', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('code_step.') && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('no Dutch value is blank or the English copied over, and none is both', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: identical to English; move it to sameAsEnglish`);
    }
    assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
});

test('placeholders survive translation, and no dashes are used as punctuation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
    }
});

test('applyNl fills only missing keys, so curated wording survives', () => {
    const curated = { 'code_step.assist.keep': 'Houden' };
    const { merged, added } = applyNl({ ...curated });
    assert.strictEqual(merged['code_step.assist.keep'], 'Houden');
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length - 1);
});

test('a reworded line replaces only the old shipped Dutch, never a workspace\'s own', () => {
    const key = 'code_step.editor.stalled';
    const shipped = 'De code-editor werd niet helemaal geladen, dus dit is het gewone tekstvak. Hij wordt de eerste keer van internet gehaald, dus een installatie zonder internet of achter een firewall krijgt hem nooit. Er gaat niets verloren: dit vak bewerkt en bewaart precies dezelfde code.';
    const fromShipped = applyNl({ [key]: shipped }).merged[key];
    assert.strictEqual(fromShipped, NL_TRANSLATIONS[key]);
    assert.ok(!/internet/.test(fromShipped));
    assert.strictEqual(applyNl({ [key]: 'Eigen tekst' }).merged[key], 'Eigen tekst');
});
