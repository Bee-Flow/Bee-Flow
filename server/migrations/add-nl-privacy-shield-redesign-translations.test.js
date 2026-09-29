/**
 * Two silent failure modes, both pinned here.
 *
 * A Dutch key that matches no English key is stored, never read, and the
 * screen quietly stays English — with no error anywhere. And an English key
 * with no Dutch one is, on THIS screen, a Dutch admin reading "you look for
 * them, but no tool holds them back" in the middle of an otherwise Dutch
 * page — on the one control that decides whether a customer's BSN can leave
 * the building.
 *
 * Run: node --test --test-force-exit migrations/add-nl-privacy-shield-redesign-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-privacy-shield-redesign-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

/**
 * Keys this catalogue deliberately leaves in English.
 *
 * The SETTING NAMES are the product's own vocabulary: they are what the docs
 * call them, what a support thread quotes, and what the round-2 artboards
 * themselves kept in English while writing the surrounding prose in Dutch.
 * Translating the switch but not the manual is worse than either. Everything
 * that EXPLAINS a setting is translated; the name on it is not.
 */
const SAME_AS_ENGLISH = new Set([
    // "placeholder" is the Dutch word too — it is what the existing NL
    // catalogue already uses for the tokenised values, and "plaatsvervanger"
    // would be a different (and wrong) thing.
    'admin.shield_summary_placeholders',
    // Identical in both languages.
    'pii.group_contact',
]);

/**
 * Prefixes this round introduced ENTIRELY, so every English key under one of
 * them is this catalogue's to translate.
 *
 * Deliberately not the bare `admin.shield_` prefix: that namespace predates
 * this round by three releases and its earlier keys belong to
 * add-nl-personal-privacy-shield-translations. A coverage assertion over a
 * namespace with two owners can only ever be wrong about it.
 */
const OWNED_PREFIXES = [
    'admin.shield_matrix_',    // the category matrix
    'admin.shield_preview_',   // "what your people see"
    'admin.shield_compliance_', // the Compliance link card
    'admin.shield_summary_',   // the pipeline strip's read-outs
    'admin.shield_map_',       // the egress map
    'admin.shield_pipeline_',  // the strip's bookends
    'admin.shield_step_',      // the two numbered checks
    'pii.group_',              // the seven category groups
];

function owned(key) {
    return OWNED_PREFIXES.some(p => key.startsWith(p));
}

/**
 * English keys retired AFTER this migration shipped. The migration has run on
 * every existing install, so its Dutch rows for these keys stay (stored and
 * never read); editing an applied migration to drop them would only make fresh
 * installs differ from old ones. Declared here rather than read from
 * i18n/defaults/removed-keys.txt, whose lines may be cleaned up once the
 * removal is merged.
 */
const RETIRED_SINCE = new Set([
    // Privacy Shield "Your own data" (2026-09): the "Always hide these" card
    // moved to its own tab, under the shield_data namespace.
    'admin.shield_manage',
    'admin.shield_hiw_exceptions_body',
    'admin.shield_custom_terms_title',
    'admin.shield_custom_terms_summary',
    'admin.shield_custom_terms_empty_summary',
    // Privacy Shield egress map (2026-09): rebuilt under the egress_map
    // namespace (add-nl-egress-map-translations). admin.shield_map_loading
    // stays in use, so the admin.shield_map_ prefix above still matches.
    'admin.shield_map_alt',
    'admin.shield_map_footnote',
    'admin.shield_map_legend_eea',
    'admin.shield_map_legend_other',
    'admin.shield_map_pin',
    'admin.shield_map_unplaced',
]);

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter(k => !(k in GUI_DEFAULTS) && !RETIRED_SINCE.has(k));
    assert.deepStrictEqual(orphans, [],
        'these Dutch keys have no English counterpart — a typo here is a screen that silently stays English');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        if (RETIRED_SINCE.has(k)) continue;
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k],
            `${k} was never actually translated — if the Dutch really is the English word, move it to SAME_AS_ENGLISH`);
    }
});

test('every interpolation placeholder survives translation', () => {
    // A dropped `{n}` is a sentence that reads fine in review and renders
    // "vragen aandacht" with no number in front of it.
    for (const [k, nl] of Object.entries(NL_TRANSLATIONS)) {
        if (RETIRED_SINCE.has(k)) continue;
        const en = GUI_DEFAULTS[k] || '';
        const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
        assert.deepStrictEqual(names(nl), names(en),
            `${k}: the Dutch does not carry the same {placeholders} as the English`);
    }
});

test('every English key under a prefix this round owns has Dutch', () => {
    // The direction that decides whether a Dutch admin sees Dutch, and the
    // one that fails SILENTLY: a missing key is not an error anywhere — t()
    // falls back to English and the screen is simply half-translated. Which
    // is exactly why it needs a test rather than a review.
    //
    // Reads from the ENGLISH catalogue, not from this file, so adding a key to
    // an owned surface and forgetting its Dutch turns this red.
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(owned)
        .filter(k => !(k in NL_TRANSLATIONS) && !SAME_AS_ENGLISH.has(k))
        .sort();
    assert.deepStrictEqual(untranslated, [],
        `English-only on a surface this catalogue owns: ${untranslated.join(', ')}`);
});

test('the owned prefixes actually match something', () => {
    // Guards the test above against becoming vacuous: a renamed namespace
    // would leave OWNED_PREFIXES matching nothing, and "no untranslated keys"
    // would then be true because there are no keys at all.
    for (const p of OWNED_PREFIXES) {
        const hits = Object.keys(GUI_DEFAULTS).filter(k => k.startsWith(p));
        assert.ok(hits.length > 0, `${p} matches no English key — renamed or removed?`);
    }
});

test('the setting NAMES stayed English on purpose, and are declared', () => {
    for (const k of SAME_AS_ENGLISH) {
        assert.ok(k in GUI_DEFAULTS, `${k} is declared identical but does not exist in English`);
        assert.ok(!(k in NL_TRANSLATIONS),
            `${k} is both declared identical AND translated — pick one`);
    }
});

test('the module exports an idempotent up()', () => {
    const mod = require('./add-nl-privacy-shield-redesign-translations');
    assert.strictEqual(typeof mod.up, 'function');
    // Only-fill-missing is what lets an operator re-run it, and what stops it
    // overwriting wording a workspace curated itself.
    const src = require('node:fs').readFileSync(
        require.resolve('./add-nl-privacy-shield-redesign-translations'), 'utf8',
    );
    assert.match(src, /addMissingGUITranslations\('nl', NL_TRANSLATIONS\)/);
});
