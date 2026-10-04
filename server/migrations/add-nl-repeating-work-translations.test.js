/**
 * The Dutch for "Find repeating work". Two silent failure modes are pinned
 * here: a Dutch key that matches no English key is stored and never read, and
 * an English key without Dutch leaves one English sentence on an otherwise
 * Dutch scan page. Neither shows an error anywhere.
 *
 * Run: node --test migrations/add-nl-repeating-work-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, up } = require('./add-nl-repeating-work-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIXES = ['automations.repeating.', 'automations.tabs.'];
const owned = (k) => OWNED_PREFIXES.some((p) => k.startsWith(p));

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('every key here sits under the prefixes this catalogue owns', () => {
    const strays = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !owned(k));
    assert.deepStrictEqual(strays, []);
});

test('no key is both translated and declared identical', () => {
    assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated; if the Dutch really is the English, move it to SAME_AS_ENGLISH`);
    }
});

test('every English key under the owned prefixes has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k))
        .sort();
    assert.deepStrictEqual(untranslated, []);
    assert.ok(Object.keys(GUI_DEFAULTS).filter(owned).length > 100, 'the automations.repeating namespace is missing from the English catalog');
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('no dashes as punctuation, in either language', () => {
    // A dash between two numbers is a range ("≈{lo}–{hi} h/month"), not
    // punctuation, so that one shape is allowed.
    const punctuation = (s) => /[–—]/.test(String(s).replace(/\}–\{/g, ''));
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.ok(!punctuation(v), `${k} (nl) uses a dash`);
    for (const k of Object.keys(GUI_DEFAULTS).filter(owned)) assert.ok(!punctuation(GUI_DEFAULTS[k]), `${k} (en) uses a dash`);
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, { ...NL_TRANSLATIONS });

    const own = applyNl({ 'automations.repeating.notNow': 'Later' });
    assert.strictEqual(own.merged['automations.repeating.notNow'], 'Later');
    assert.strictEqual(own.added, Object.keys(NL_TRANSLATIONS).length - 1);
});

test('a second run changes nothing', () => {
    const first = applyNl({});
    const second = applyNl({ ...first.merged });
    assert.strictEqual(second.added, 0);
    assert.deepStrictEqual(second.merged, first.merged);
});

test('the keys kept from the earlier scan screen keep the Dutch an install already has', () => {
    // These were seeded by add-nl-builder-handoff5-translations before they
    // moved here. The same Dutch means an install that ran that catalogue
    // shows no change, and a fresh one gets the same words.
    assert.strictEqual(NL_TRANSLATIONS['automations.repeating.title'], 'Herhalend werk vinden');
    assert.strictEqual(NL_TRANSLATIONS['automations.repeating.scan'], 'Mijn recente werk scannen');
    assert.strictEqual(NL_TRANSLATIONS['automations.repeating.adjust'], 'Eerst aanpassen');
});

test('no other Dutch catalogue seeds these keys', () => {
    const mine = new Set([...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH]);
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-repeating-work-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)); } catch { continue; }
        const keys = [
            ...Object.keys((other && typeof other.NL_TRANSLATIONS === 'object' && other.NL_TRANSLATIONS) || {}),
            ...(Array.isArray(other && other.SAME_AS_ENGLISH) ? other.SAME_AS_ENGLISH : []),
        ];
        for (const k of keys) if (mine.has(k) || owned(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-repeating-work-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
});
