/**
 * Two silent failure modes, both pinned here.
 *
 * A Dutch key that matches no English key is stored, never read, and the UI
 * quietly stays English — with no error anywhere. And an English key with no
 * Dutch one is a builder that asks "is a list of 3, this needs one text. What
 * do you want?" in the middle of an otherwise Dutch screen — on the one
 * control that stops somebody binding an array into an e-mail subject.
 *
 * Run: node --test --test-force-exit migrations/add-nl-builder-redesign-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-builder-redesign-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The namespaces the builder redesign owns.
//
// `automations.builder.*` is NOT one of them, and the reason written here used to
// be wrong: it said the prefix was "translated elsewhere". Nothing had
// translated it — 77 of its 115 keys carried no Dutch at all, including every
// word of the list chooser. The prefix is excluded here because it is seeded
// by more than one catalogue (this one, add-nl-approvals, add-nl-builder-
// values), so a per-file assertion could only ever be wrong about it. Its
// coverage direction lives in add-nl-builder-values-translations.test.js,
// which asserts it over the UNION of every catalogue — a test that can go red,
// where this comment could not.
const OWNED_PREFIXES = [
    'automations.picker.', 'automations.kind.', 'automations.mapping.', 'automations.mismatch.',
    'automations.card.', 'automations.canvas.', 'automations.ndv.', 'automations.ribbon.',
    'automations.node.group.',
];
// `choice` arrived with the datatables track and its Dutch ships there — one
// key, one owner, so boot order cannot decide the wording.
// Handoff 5 (2026-09-28) added keys under these prefixes; their Dutch ships in
// add-nl-builder-handoff5-translations, for the same reason.
// The nested-data mapping work (2026-10-05) did the same; its Dutch ships in
// add-nl-builder-mapping-translations.
const handoff5 = require('./add-nl-builder-handoff5-translations');
const mapping = require('./add-nl-builder-mapping-translations');
const OWNED_ELSEWHERE = new Set([
    'automations.kind.choice',
    ...Object.keys(handoff5.NL_TRANSLATIONS),
    ...handoff5.SAME_AS_ENGLISH,
    ...Object.keys(mapping.NL_TRANSLATIONS),
]);

function owned(key) {
    if (OWNED_ELSEWHERE.has(key)) return false;
    return OWNED_PREFIXES.some(p => key.startsWith(p));
}

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [],
        'these Dutch keys have no English counterpart — a typo here is a screen that silently stays English');
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k],
            `${k} was never actually translated — if the Dutch really is the English word, move it to SAME_AS_ENGLISH`);
    }
});

test('every English builder-redesign key has a Dutch one (or is declared identical)', () => {
    // The direction that decides whether a Dutch author sees Dutch. A missing
    // key is not an error anywhere: t() falls back to English and the screen
    // looks fine to whoever wrote it.
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => owned(k) && !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    // "{n}" dropped from "is een lijst van {n}" is a question that no longer
    // says how big the list is — which is the whole reason the box opened.
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the plain-language kinds never say string, array or object', () => {
    // The whole point of artboard 2c. A Dutch translation that reuses the
    // technical word undoes it silently.
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        if (!k.startsWith('automations.kind.') && !k.startsWith('automations.mismatch.')) continue;
        assert.doesNotMatch(v, /\b(string|array|object|boolean)\b/i, `${k} leaks a technical type word`);
    }
});

test('the artboard words are used literally where the design has them', () => {
    // The design for this round was written in Dutch; these are its exact
    // phrases. If one changes, it changes in the artboard first.
    const expected = {
        'automations.ndv.incoming': 'Komt binnen',
        'automations.ndv.settings': 'Instellingen',
        'automations.ndv.continues': 'Gaat verder',
        'automations.mapping.use_whole_group': 'hele groep gebruiken',
        'automations.mismatch.choice_lines': 'Alles achter elkaar, elk op een nieuwe regel',
        'automations.mismatch.choice_first': 'Alleen de eerste',
        'automations.canvas.row_label': 'Rij {n}',
        'automations.canvas.wrap_chip': '→ rij {row} · stap {step}',
        'automations.canvas.open_form': 'Formulier openen',
        'automations.builder.one_field_empty': '1 veld nog leeg',
        'automations.ndv.runs_n_times_per': 'draait {n}× · één per {list}',
        'automations.mapping.iteration_of': '{n} van {total}',
        'automations.mapping.per_step': 'Per stap',
        'automations.mapping.all': 'Alles',
        'automations.kind.list_of_n_kind': 'van {n} · {kind}',
    };
    for (const [k, v] of Object.entries(expected)) {
        assert.strictEqual(NL_TRANSLATIONS[k], v, `${k} drifted from the artboard wording`);
    }
});

test('the migration is registered, or it never runs', () => {
    // A migration file that boot never requires is a file that does nothing —
    // and the symptom (Dutch that silently stays English) looks identical to a
    // typo, so it is worth one assertion rather than an afternoon.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-builder-redesign-translations'"),
        'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});
