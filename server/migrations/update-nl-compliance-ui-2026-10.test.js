/**
 * Dutch for the Compliance Center UI, round 2. Pins: every key exists in
 * English, the rewording only replaces the OLD shipped Dutch (a workspace's
 * own wording survives), a fresh install and an upgraded one end up with the
 * same Dutch, and the data hash.
 *
 * Run: node --test migrations/update-nl-compliance-ui-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NL_TRANSLATIONS, NL_REWORDED, applyNl, DATA_SHA256 } = require('./update-nl-compliance-ui-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const SEED = require('./data/compliance-center-nl.json');
const COLLAB = require('./add-nl-collaboration-wave2-documents-compliance-translations');

/** What a fresh install seeds for a key: the generated map, or the catalogue that owns the key's family. */
const seeded = (k) => SEED[k] ?? COLLAB.NL_TRANSLATIONS[k];

function sha256Of(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('the pinned hash is the data file\'s, so a data change re-runs the migration', () => {
    assert.strictEqual(sha256Of(path.join(__dirname, 'data', 'compliance-ui-2026-10-nl.json')), DATA_SHA256);
});

test('every key exists in the English catalog, has Dutch, and is not the English copied over', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...Object.keys(NL_REWORDED)];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), []);
    for (const k of Object.keys(NL_TRANSLATIONS)) {
        assert.ok(NL_TRANSLATIONS[k].trim(), `${k}: empty`);
        assert.notStrictEqual(NL_TRANSLATIONS[k], GUI_DEFAULTS[k], `${k}: English copied`);
    }
    for (const [k, { was, now }] of Object.entries(NL_REWORDED)) {
        assert.ok(now.trim() && was.trim(), `${k}: empty`);
        assert.notStrictEqual(now, was, `${k}: not reworded`);
        assert.notStrictEqual(now, GUI_DEFAULTS[k], `${k}: English copied`);
    }
});

test('placeholders survive translation', () => {
    const names = (s) => [...String(s).matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.deepStrictEqual(names(v), names(GUI_DEFAULTS[k]), k);
    for (const [k, { now }] of Object.entries(NL_REWORDED)) assert.deepStrictEqual(names(now), names(GUI_DEFAULTS[k]), k);
});

test('a fresh install seeds the same Dutch, so a new and an upgraded workspace agree', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.strictEqual(seeded(k), v, k);
    for (const [k, { now }] of Object.entries(NL_REWORDED)) assert.strictEqual(seeded(k), now, k);
});

test('the round\'s reworded English carries reworded Dutch', () => {
    // The English of these changed meaning in round 2; their old Dutch
    // described the old text.
    assert.deepStrictEqual(Object.keys(NL_REWORDED).sort(), [
        'compliance.ovw_deadlines_hint', 'compliance.rail_audits', 'compliance.settings.project_retention_days',
    ]);
    assert.strictEqual(NL_REWORDED['compliance.ovw_deadlines_hint'].now, 'Wettelijke reactietermijnen, meest urgente eerst');
    assert.strictEqual(NL_REWORDED['compliance.rail_audits'].now, 'Audits & beoordelingen');
    // Keys whose English changed but whose Dutch never shipped are plain additions.
    assert.strictEqual(NL_TRANSLATIONS['compliance.ai_literacy_confirmed_at'], 'Bevestigd op {date}');
    assert.strictEqual(NL_TRANSLATIONS['compliance.dpia_q_mitigations_short'], 'Maatregelen');
});

test('applyNl adds missing keys, replaces the old shipped Dutch, and keeps a workspace\'s own wording', () => {
    const [rewordKey, { was, now }] = Object.entries(NL_REWORDED)[0];
    const [otherKey] = Object.keys(NL_REWORDED).slice(1);
    const [newKey, newValue] = Object.entries(NL_TRANSLATIONS)[0];
    const [ownKey] = Object.keys(NL_TRANSLATIONS).slice(1);
    const blob = {
        [rewordKey]: was,
        [otherKey]: 'Onze eigen formulering',
        [ownKey]: 'Ook van ons',
        unrelated: 'blijft',
    };
    const { merged, added, reworded } = applyNl({ ...blob });
    assert.strictEqual(merged[rewordKey], now);
    assert.strictEqual(merged[otherKey], 'Onze eigen formulering');
    assert.strictEqual(merged[newKey], newValue);
    assert.strictEqual(merged[ownKey], 'Ook van ons');
    assert.strictEqual(merged.unrelated, 'blijft');
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length - 1);
    // The old text replaced, plus the reworded keys the blob did not have at all.
    assert.strictEqual(reworded, Object.keys(NL_REWORDED).length - 1);
    // Idempotent: a second run changes nothing and counts nothing.
    const again = applyNl({ ...merged });
    assert.deepStrictEqual(again.merged, merged);
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.reworded, 0);
});

test('the boot ladder runs it after the catalogues it corrects and before the routine rename', () => {
    const { NL_TRANSLATIONS: ladder } = require('../boot/bootMigrations');
    const at = (name) => ladder.indexOf(name);
    assert.ok(at('update-nl-compliance-ui-2026-10') > at('add-nl-compliance-center-translations'));
    assert.ok(at('update-nl-compliance-ui-2026-10') > at('add-nl-collaboration-wave2-documents-compliance-translations'));
    assert.ok(at('update-nl-compliance-ui-2026-10') < at('rename-routine-i18n-2026-10'));
});
