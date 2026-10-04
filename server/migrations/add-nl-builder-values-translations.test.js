/**
 * The coverage direction for `automations.builder.*` — ALL of it, not just the
 * keys this migration happens to carry.
 *
 * Why here and not in the sibling test: `add-nl-builder-redesign-translations`
 * excluded the whole prefix with the comment "translated elsewhere". Nothing
 * translated it. 77 of 115 keys had no Dutch at all — including every word of
 * the list chooser, the box whose entire job is to stop somebody binding a
 * list of addresses into an e-mail subject. A comment cannot go red; this
 * test can. It reads the union of every add-nl-* catalogue that touches the
 * prefix, so the answer does not depend on which file a key lands in.
 *
 * Run: node --test --test-force-exit migrations/add-nl-builder-values-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { NL_TRANSLATIONS } = require('./add-nl-builder-values-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const PREFIX = 'automations.builder.';
const MIGRATIONS_DIR = __dirname;

/**
 * Every `automations.builder.*` key any Dutch catalogue seeds, mapped to the file
 * that seeds it. Read from the SOURCE rather than by requiring each module: a
 * migration that fails to load would otherwise silently look like a migration
 * with no keys, and this test would go green on an empty union.
 */
function dutchBuilderKeys() {
    const found = new Map();
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => /^add-nl-.*\.js$/.test(f) && !f.endsWith('.test.js'));
    assert.ok(files.length > 5, 'no add-nl-* catalogues found — the scan is looking in the wrong place');
    for (const f of files) {
        const src = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        for (const m of src.matchAll(/^\s*'(automations\.builder\.[A-Za-z0-9_.]+)':/gm)) {
            if (!found.has(m[1])) found.set(m[1], f);
        }
    }
    return found;
}

test('every English automations.builder.* key has Dutch in some catalogue', () => {
    // The direction that decides whether a Dutch author sees Dutch. A missing
    // key is not an error anywhere: t() falls back to English, and the screen
    // looks finished to whoever wrote it in English.
    const dutch = dutchBuilderKeys();
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => k.startsWith(PREFIX) && !dutch.has(k))
        .sort();
    assert.deepStrictEqual(untranslated, [],
        'these builder keys render English inside a Dutch workspace');
});

test('the scan really finds this catalogue — it is not reading an empty union', () => {
    // Guards the guard: a regex that stops matching turns the test above into
    // a test of nothing at all, and it would stay green forever.
    const dutch = dutchBuilderKeys();
    const mine = [...dutch].filter(([, f]) => f === 'add-nl-builder-values-translations.js');
    assert.strictEqual(mine.length, Object.keys(NL_TRANSLATIONS).length,
        'the source scan and the module disagree about how many keys this file carries');
});

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, [],
        'these Dutch keys have no English counterpart — a typo here is a screen that silently stays English');
});

test('no key is seeded twice by two catalogues', () => {
    // Two migrations racing to fill the same key makes the wording depend on
    // boot order — the failure the redesign catalogue avoided by hand for
    // automations.kind.choice. Here it is an assertion.
    const seen = new Map();
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter(x => /^add-nl-.*\.js$/.test(x) && !x.endsWith('.test.js'))) {
        const src = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        for (const m of src.matchAll(/^\s*'(automations\.builder\.[A-Za-z0-9_.]+)':/gm)) {
            const prev = seen.get(m[1]);
            assert.ok(!prev, `${m[1]} is seeded by both ${prev} and ${f}`);
            seen.set(m[1], f);
        }
    }
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

test('placeholders survive translation', () => {
    // "{n}" dropped from "is een lijst van {n}" is a question that no longer
    // says how big the list is — which is the whole reason the box opened.
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the value vocabulary never says string, array or object', () => {
    // Same rule as artboard 2c: the plain-language words exist because the
    // technical ones say nothing to a non-programmer. `steps.s1.output.total`
    // in the expression hint is an EXAMPLE of what to type, not a type word.
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.doesNotMatch(v, /\b(string|array|object|boolean)\b/i, `${k} leaks a technical type word`);
    }
});

test('the two boxes that ask the same question use the same Dutch words', () => {
    // MismatchResolver (automations.mismatch.*) and ListPickChooser
    // (automations.builder.*) render the SAME five answers from two modules. The
    // English drifted ("Only the first" vs "Just the first one"). If the Dutch
    // drifts too, a user learns the answer in one box and does not recognise
    // it in the other — on the control that prevents a bad binding.
    const { NL_TRANSLATIONS: REDESIGN } = require('./add-nl-builder-redesign-translations');
    const PAIRS = [
        ['automations.builder.choice_first', 'automations.mismatch.choice_first'],
        ['automations.builder.choice_last', 'automations.mismatch.choice_last'],
        ['automations.builder.choice_each', 'automations.mismatch.choice_each'],
    ];
    for (const [mine, theirs] of PAIRS) {
        assert.strictEqual(NL_TRANSLATIONS[mine], REDESIGN[theirs],
            `${mine} and ${theirs} are the same act and must read the same`);
    }
});

test('the migration is registered, or it never runs', () => {
    // A migration file that boot never requires is a file that does nothing —
    // and the symptom (Dutch that silently stays English) looks identical to a
    // typo.
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-builder-values-translations'"),
        'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});

test('up() only ever ADDS — it cannot overwrite curated wording', () => {
    // The store call is the whole safety property: a workspace that rewrote a
    // sentence keeps it across every boot of every replica. Asserted on the
    // source because there is no Postgres here to run it against.
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, 'add-nl-builder-values-translations.js'), 'utf8');
    assert.match(src, /addMissingGUITranslations\('nl', NL_TRANSLATIONS\)/);
    assert.doesNotMatch(src, /setGUITranslations|replaceGUITranslations|upsertGUITranslation\b/);
});

test('up() hands the whole catalogue to the ADD-only store call, and reports what landed', async () => {
    // There is no Postgres in this container, so the store is stubbed on the
    // module instance up() itself requires. That still proves the two things
    // that can actually go wrong here: the catalogue reaching the store intact
    // (a partial object is a half-Dutch screen), and up() reporting the store's
    // own count rather than its own guess.
    const languageStore = require('../stores/languageStore');
    const real = languageStore.addMissingGUITranslations;
    const seen = [];
    languageStore.addMissingGUITranslations = async (locale, map) => {
        seen.push({ locale, keys: Object.keys(map) });
        // Pretend the workspace already curated two of them: an ADD-only call
        // leaves those alone, which is why `added` is smaller than the map.
        return { added: Object.keys(map).length - 2 };
    };
    try {
        const { up } = require('./add-nl-builder-values-translations');
        const result = await up();
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].locale, 'nl');
        assert.deepStrictEqual(seen[0].keys, Object.keys(NL_TRANSLATIONS));
        assert.strictEqual(result.added, Object.keys(NL_TRANSLATIONS).length - 2);
    } finally {
        languageStore.addMissingGUITranslations = real;
    }
});
