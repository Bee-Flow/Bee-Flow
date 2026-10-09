/**
 * The Dutch for the builder fixes of October 2026. Pins the silent failure
 * modes: a Dutch key without an English one is never read, an English key
 * without Dutch leaves English in a Dutch screen.
 *
 * Run: node --test migrations/add-nl-builder-fixes-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256, applyNl, up } = require('./add-nl-builder-fixes-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIXES = ['http_query.', 'automationAgentBindings.', 'automations.assistant.questions_', 'automations.assistant.plan_', 'studio.no_access.'];

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('no key is both translated and declared identical', () => {
    assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never translated; move it to sameAsEnglish`);
    }
});

test('every English key in the owned namespaces has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const missing = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(missing, []);
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'http_query.add': 'Param erbij' });
    assert.strictEqual(own.merged['http_query.add'], 'Param erbij');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});

test('no other Dutch catalogue seeds these keys', () => {
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^(add|update)-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-builder-fixes-2026-10.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, []);
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-builder-fixes-2026-10'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
});

test('the pinned data hash matches the data file', () => {
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'builder-fixes-2026-10-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual, `set DATA_SHA256 to ${actual}`);
});
