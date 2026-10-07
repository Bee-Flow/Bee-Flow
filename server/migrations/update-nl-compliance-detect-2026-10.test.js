/**
 * Dutch for the round 2 detection and legal-wording fixes. Pins: every key
 * exists in English, the rewording only replaces Dutch that shipped earlier
 * (every shipped variant, and nothing a workspace wrote itself), the new Dutch
 * matches the seed map, the DSR clock no longer says 30 days, the boot order,
 * and the data hash.
 *
 * Run: node --test migrations/update-nl-compliance-detect-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl, DATA_SHA256 } = require('./update-nl-compliance-detect-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const SEED = require('./data/compliance-center-nl.json');
const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');

const placeholders = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();

test('the pinned hash is the data file\'s, so a data change re-runs the migration', () => {
    const data = fs.readFileSync(path.join(__dirname, 'data', 'compliance-detect-2026-10-nl.json'));
    assert.strictEqual(crypto.createHash('sha256').update(data).digest('hex'), DATA_SHA256);
});

test('every key exists in the English catalog, has Dutch, and is not the English copied over', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...Object.keys(NL_REWORDED)];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => k in NL_REWORDED), [], 'a key is either new or reworded');
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(v.trim(), `${k}: empty`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: English copied`);
        assert.deepStrictEqual(placeholders(v), placeholders(GUI_DEFAULTS[k]), `${k}: placeholders differ`);
    }
    for (const [k, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim(), `${k}: empty`);
        assert.ok(was.length > 0 && was.every((w) => w.trim()), `${k}: no earlier shipped text`);
        assert.ok(!was.includes(now), `${k}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[k], `${k}: English copied`);
        assert.deepStrictEqual(placeholders(now), placeholders(GUI_DEFAULTS[k]), `${k}: placeholders differ`);
    }
});

test('the seed map carries the same new Dutch, so a fresh install and an upgraded one agree', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.strictEqual(SEED[k], v, k);
    for (const [k, { now }] of Object.entries(NL_REWORDED)) assert.strictEqual(SEED[k], now, k);
});

test('the DSR clock reads one month, and an extension two months, in Dutch too (GDPR Art. 12(3))', () => {
    const clock = [
        'compliance.dsr_toast_captured', 'compliance.hdr_dsr_window', 'compliance.ovw_deadlines_hint', 'compliance.dsr_subtitle',
        'compliance.nav_dsr_desc', 'compliance.dsr_capture_desc', 'compliance.dsr_pf_intro',
    ];
    for (const k of clock) {
        assert.doesNotMatch(SEED[k], /30[- ]?dag/i, `${k}: still 30 days in the seed`);
        assert.match(SEED[k], /één maand|1 maand/, `${k}: no one-month clock`);
    }
    // dsrStore.extend adds two calendar months; the button, its confirmation and the toast say so.
    for (const k of ['compliance.dsr_extend_60', 'compliance.dsr_extend_confirm', 'compliance.dsr_toast_extended']) {
        assert.doesNotMatch(SEED[k], /60/, `${k}: still 60 days in the seed`);
        assert.match(SEED[k], /(2|twee) maanden/, `${k}: no two-month extension`);
    }
    // The old "30 days" / "60 days" Dutch an existing workspace has is replaced, not kept.
    assert.ok(NL_REWORDED['compliance.dsr_toast_captured'].was.some((w) => /30-dagenklok/.test(w)));
    assert.ok(NL_REWORDED['compliance.dsr_toast_extended'].was.some((w) => /60 dagen/.test(w)));
});

test('applyNl adds missing keys, replaces every old shipped variant, and keeps a workspace\'s own wording', () => {
    const [multiKey, multi] = Object.entries(NL_REWORDED).find(([, r]) => r.was.length > 1);
    const [singleKey, single] = Object.entries(NL_REWORDED).find(([k, r]) => k !== multiKey && r.was.length === 1);
    const [ownKey] = Object.keys(NL_REWORDED).filter((k) => k !== multiKey && k !== singleKey);
    const [newKey] = Object.keys(NL_TRANSLATIONS);
    const blob = {
        [multiKey]: multi.was[multi.was.length - 1], // a variant other than the first: the whole list counts
        [singleKey]: single.was[0],
        [ownKey]: 'Onze eigen formulering',
        [newKey]: '',
        unrelated: 'blijft',
    };
    const { merged, added, reworded } = applyNl({ ...blob });
    assert.strictEqual(merged[multiKey], multi.now);
    assert.strictEqual(merged[singleKey], single.now);
    assert.strictEqual(merged[ownKey], 'Onze eigen formulering');
    assert.strictEqual(merged[newKey], NL_TRANSLATIONS[newKey]);
    assert.strictEqual(merged.unrelated, 'blijft');
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    // Every reworded key but the workspace's own: two replaced, the rest were missing.
    assert.strictEqual(reworded, Object.keys(NL_REWORDED).length - 1);
    // Idempotent: a second run changes nothing.
    const again = applyNl({ ...merged });
    assert.deepStrictEqual(again.merged, merged);
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.reworded, 0);
});

test('it runs at boot after the legal register review and before the routine → automation rename', () => {
    const at = BOOT_LIST.indexOf('update-nl-compliance-detect-2026-10');
    assert.ok(at > BOOT_LIST.indexOf('update-nl-legal-register-2026-10'), 'must follow update-nl-legal-register-2026-10, whose Dutch it replaces');
    assert.ok(at < BOOT_LIST.indexOf('rename-routine-i18n-2026-10'));
});
