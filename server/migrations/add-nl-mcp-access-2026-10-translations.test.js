/**
 * The Dutch for the MCP access screens (2026-10). A Dutch key without an
 * English counterpart is stored and never read; an English key without Dutch
 * leaves one English sentence in a Dutch screen.
 *
 * Run: node --test migrations/add-nl-mcp-access-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, up } = require('./add-nl-mcp-access-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const OWNED_PREFIX = 'mcp_access.';

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no key is both translated and declared identical', () => {
    assert.deepStrictEqual(SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS), []);
});

test('every English mcp_access key has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => k.startsWith(OWNED_PREFIX) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never translated; if the Dutch really is the English, move it to SAME_AS_ENGLISH`);
    }
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('no dashes as punctuation in the new text, in either language', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
        assert.ok(!/[–—]/.test(GUI_DEFAULTS[k]), `${k} (en) uses a dash`);
    }
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept, a second run changes nothing', () => {
    const first = applyNl({});
    assert.strictEqual(first.added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ [Object.keys(NL_TRANSLATIONS)[0]]: 'Eigen woord' });
    assert.strictEqual(own.merged[Object.keys(NL_TRANSLATIONS)[0]], 'Eigen woord');
    const second = applyNl({ ...first.merged });
    assert.strictEqual(second.added, 0);
});

test('no other Dutch catalogue seeds these keys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-mcp-access-2026-10-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-mcp-access-2026-10-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
});
