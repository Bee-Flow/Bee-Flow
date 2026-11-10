/**
 * The Dutch for the new-email trigger (Cowork and the agent's mail trigger
 * dialog). A Dutch key without an English counterpart is stored and never read;
 * an English key of this round without Dutch leaves English in a Dutch screen.
 *
 * Run: node --test migrations/add-nl-mail-trigger-2026-11-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256, applyNl } = require('./add-nl-mail-trigger-2026-11-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The keys this round owns: everything of the mail trigger.
const OWNED_KEYS = new Set(['cowork.composer.start_watching', 'cowork.flash.watching_mail', 'cowork.edit.mail_trigger', 'agent_schedules.new_mail_trigger']);
const OWNED_PREFIXES = ['cowork.mail_trigger.', 'agent_schedules.mail_trigger_'];
const OWNED = (k) => OWNED_KEYS.has(k) || OWNED_PREFIXES.some((p) => k.startsWith(p));

test('every key exists in English, and every key of this round has Dutch (or is declared identical)', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS).filter((k) => OWNED(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('the Dutch is Dutch, placeholders survive, and an identical word is declared, not seeded', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(v.trim(), `${k}: empty`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: English copied (list it under sameAsEnglish)`);
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), k);
    }
    for (const k of SAME_AS_ENGLISH) assert.ok(!(k in NL_TRANSLATIONS), `${k}: both seeded and declared identical`);
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);
    const [first] = Object.keys(NL_TRANSLATIONS);
    const own = applyNl({ [first]: 'Eigen woord' });
    assert.strictEqual(own.merged[first], 'Eigen woord');
    const again = applyNl({ ...merged });
    assert.strictEqual(again.added, 0);
    assert.deepStrictEqual(again.merged, merged);
});

test('no other Dutch catalogue seeds these keys', () => {
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^(add|update)-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-mail-trigger-2026-11-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'mail-trigger-2026-11-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/mail-trigger-2026-11-nl.json changed: set DATA_SHA256 in add-nl-mail-trigger-2026-11-translations.js to ' + actual);
});

test('the boot ladder runs it', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    assert.ok(ladder.includes('add-nl-mail-trigger-2026-11-translations'), 'not registered in boot/bootMigrations.js');
});
