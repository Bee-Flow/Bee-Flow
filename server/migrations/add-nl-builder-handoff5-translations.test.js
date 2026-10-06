/**
 * The Dutch for the automation builder of design handoff 5. Two silent
 * failure modes are pinned here: a Dutch key that matches no English key is
 * stored and never read, and an English key without Dutch leaves one English
 * sentence in an otherwise Dutch screen. Neither shows an error anywhere.
 *
 * Run: node --test migrations/add-nl-builder-handoff5-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl, up } = require('./add-nl-builder-handoff5-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// Namespaces that exist only because of handoff 5, so every English key
// under them must have Dutch here (or be declared identical).
// `automations.repeating.` moved to add-nl-repeating-work-translations when the
// "Find repeating work" page was rebuilt (2026-10); its test owns it now.
const OWNED_PREFIXES = [
    'automations.agent_step.', 'automations.aiact.', 'automations.header.',
    'automations.holidays.', 'automations.library.', 'automations.notify.', 'automations.people.',
    'automations.ready.', 'automations.role.', 'automations.schedule.', 'automations.settings.',
    'automations.sharing.', 'automations.status.', 'automations.step_error.', 'automations.templates.',
    'automations.versions.', 'runs.day.', 'runs.duration.', 'runs.how.', 'runs.io.', 'runs.log.', 'runs.noun.',
    'runs.reason.', 'runs.sentence.', 'runs.tab.', 'runs.timeline.', 'runs.waited.',
];

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart');
});

test('no key is both translated and declared identical', () => {
    const both = SAME_AS_ENGLISH.filter((k) => k in NL_TRANSLATIONS);
    assert.deepStrictEqual(both, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated; if the Dutch really is the English, move it to SAME_AS_ENGLISH`);
    }
});

// Keys added later under these prefixes whose Dutch ships in another
// catalogue: one key, one owner.
const OWNED_ELSEWHERE = new Set(Object.keys(require('./add-nl-builder-mapping-translations').NL_TRANSLATIONS));

test('every English key in the handoff 5 namespaces has Dutch (or is declared identical)', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)) && !OWNED_ELSEWHERE.has(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
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

test('the artboard words are the ones used', () => {
    assert.strictEqual(NL_TRANSLATIONS['automations.header.status_never_live'], 'Concept · nog nooit live');
    assert.strictEqual(NL_TRANSLATIONS['automations.header.make_live'], 'v{version} live zetten');
    assert.strictEqual(NL_TRANSLATIONS['automations.settings.sharing'], 'Wie mag wat');
    assert.strictEqual(NL_TRANSLATIONS['runs.tab.run_again'], 'Nog eens met deze invoer');
    assert.strictEqual(NL_TRANSLATIONS['automations.versions.milestonesOnly'], 'Alleen mijlpalen');
});

test('a blob without the keys gets all of them, a workspace\'s own wording is kept', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    assert.deepStrictEqual(merged, NL_TRANSLATIONS);

    const own = applyNl({ 'automations.header.activate': 'Aanzetten' });
    assert.strictEqual(own.merged['automations.header.activate'], 'Aanzetten');
    assert.strictEqual(own.added, Object.keys(NL_TRANSLATIONS).length - 1);
});

test('a second run changes nothing', () => {
    const first = applyNl({});
    const second = applyNl({ ...first.merged });
    assert.strictEqual(second.added, 0);
    assert.deepStrictEqual(second.merged, first.merged);
});

test('no other Dutch catalogue seeds these keys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const mine = new Set(Object.keys(NL_TRANSLATIONS));
    const clashes = [];
    for (const f of fs.readdirSync(__dirname)) {
        if (!/^add-nl-.*\.js$/.test(f) || f.endsWith('.test.js') || f === 'add-nl-builder-handoff5-translations.js') continue;
        let other;
        try { other = require(path.join(__dirname, f)).NL_TRANSLATIONS; } catch { continue; }
        if (!other || typeof other !== 'object') continue;
        for (const k of Object.keys(other)) if (mine.has(k)) clashes.push(`${f}: ${k}`);
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-builder-handoff5-translations'), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
    assert.strictEqual(typeof up, 'function');
});

test('the pinned data hash matches the data file, so a data change re-runs the migration', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { DATA_SHA256 } = require('./add-nl-builder-handoff5-translations');
    const actual = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, 'data', 'builder-handoff5-nl.json')))
        .digest('hex');
    assert.strictEqual(DATA_SHA256, actual,
        'data/builder-handoff5-nl.json changed: set DATA_SHA256 in add-nl-builder-handoff5-translations.js to ' + actual
        + ' so installs that already ran this migration run it again');
});
