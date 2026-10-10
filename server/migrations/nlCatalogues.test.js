/**
 * The generic rules every Dutch catalogue (add-nl-* / update-nl-*) answers to,
 * run for each catalogue the directory holds. A new catalogue is picked up by
 * discovery: no per-catalogue copy of these checks is needed (or wanted), and
 * a catalogue that is not registered in the boot ladder fails here.
 *
 * What stays in a catalogue's own test file: the checks that need knowledge of
 * that catalogue (the namespaces it owns, its applyNl behaviour, its data
 * hash, boot ORDER constraints, hard-coded expectations).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const { NL_TRANSLATIONS: BOOT_LIST, LOOSE_MIGRATIONS } = require('../boot/bootMigrations');

const NAMES = fs.readdirSync(__dirname)
    .filter((f) => /^(add|update)-nl-.*\.js$/.test(f) && !f.endsWith('.test.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();

/** The placeholders of a string, sorted: `{name}` and `{{name}}`. */
const holes = (s) => (String(s).match(/\{\{?[a-z0-9_][a-z0-9_.]*\}?\}/gi) || []).sort();
/** Number of ICU plural/select blocks. */
const icu = (s) => (String(s).match(/\{\s*\w+\s*,\s*(plural|select)/g) || []).length;

const mods = new Map();
for (const name of NAMES) {
    let mod;
    try { mod = require(`./${name}`); } catch { mod = null; }
    mods.set(name, mod);
}
const withTable = NAMES.filter((n) => {
    const t = mods.get(n)?.NL_TRANSLATIONS;
    return t && typeof t === 'object';
});

// Catalogues that deliberately sit outside the boot ladder (their caller was
// switched off, the file stays so replay of the migration series works).
const NOT_IN_LADDER = new Set([
    'add-nl-kb-usage-translations',
]);

// Catalogues that predate a rule and break it today. They are listed so the
// rule gates every NEW catalogue and every catalogue that already obeys it;
// the list may only get shorter. Their own test file keeps its version of the
// check (or, where it never had one, the gap is recorded here).
const GRANDFATHERED = {
    orphan: new Set([
    'add-nl-plan-change-translations',
    'add-nl-privacy-shield-redesign-translations',
    'add-nl-privacy-shield-v3-translations',
    ]),
    copied: new Set([
    'add-nl-approvals-translations',
    'add-nl-builder-mapping-translations',
    'add-nl-condition-node-translations',
    'add-nl-connections-translations',
    'add-nl-cowork-translations',
    'add-nl-flatten-node-translations',
    'add-nl-learning-center-translations',
    'add-nl-plan-change-translations',
    'add-nl-project-collab-translations',
    'add-nl-project-tasks-translations',
    'add-nl-projects-collab-translations',
    'add-nl-routines-nodes-translations',
    'add-nl-settings-translations',
    'add-nl-solution-overview-2-translations',
    'add-nl-solution-overview-translations',
    'add-nl-subscription-translations',
    'update-nl-memory-2026-10',
    ]),
    holes: new Set([
    'add-nl-privacy-shield-redesign-translations',
    'add-nl-privacy-shield-v3-translations',
    ]),
};

test('discovery finds the catalogues', () => {
    assert.ok(NAMES.length >= 60, `found only ${NAMES.length} catalogue files`);
    assert.ok(withTable.length >= 50, `found only ${withTable.length} catalogues with a table`);
    for (const n of NAMES) assert.ok(mods.get(n), `${n} does not load`);
});

for (const name of NAMES) {
    test(`${name}: it is registered in the boot ladder, or it never runs, and exports up()`, () => {
        if (NOT_IN_LADDER.has(name)) {
            assert.ok(!BOOT_LIST.includes(name), `${name} is registered after all; take it out of NOT_IN_LADDER`);
        } else {
            assert.ok(BOOT_LIST.includes(name), 'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
        }
        assert.strictEqual(typeof mods.get(name).up, 'function');
    });
}

for (const name of withTable) {
    const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = mods.get(name);
    const same = Array.isArray(SAME_AS_ENGLISH) ? SAME_AS_ENGLISH : [];

    if (!GRANDFATHERED.orphan.has(name)) test(`${name}: every Dutch key exists in the English catalog`, () => {
        const orphans = [...Object.keys(NL_TRANSLATIONS), ...same].filter((k) => !(k in GUI_DEFAULTS));
        assert.deepStrictEqual(orphans, [], 'these Dutch keys have no English counterpart (removed or renamed?)');
    });

    if (!GRANDFATHERED.copied.has(name)) test(`${name}: no Dutch value is blank or the English copied over`, () => {
        for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
            assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
            assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated; if the Dutch really is the English, declare it identical`);
        }
    });

    test(`${name}: no key is both translated and declared identical`, () => {
        assert.deepStrictEqual(same.filter((k) => k in NL_TRANSLATIONS), []);
    });

    if (!GRANDFATHERED.holes.has(name)) test(`${name}: placeholders survive translation`, () => {
        for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
            assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
        }
    });

    test(`${name}: ICU plural/select blocks survive translation`, () => {
        for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
            assert.strictEqual(icu(v), icu(GUI_DEFAULTS[k]), `${k}: plural/select structure differs from English`);
        }
    });
}

// Catalogues whose keys are known to be exclusively theirs among the add-nl
// files. Newer catalogues must join this list; older ones overlap on purpose
// or by history (project_collab.prefs.* is seeded twice, identically).
const SOLE_OWNER = [
    'add-nl-builder-fixes-2026-10',
    'add-nl-builder-handoff5-translations',
    'add-nl-hardcoded-admin-2026-10-translations',
    'add-nl-hardcoded-automation-builder-2026-10-translations',
    'add-nl-hardcoded-integrations-agents-2026-10-translations',
    'add-nl-hardcoded-pages-shell-2026-10-translations',
    'add-nl-hardcoded-studio-admin-2026-10-translations',
    'add-nl-hardcoded-website-admin-2026-10-translations',
    'add-nl-learn-content-2026-10-translations',
    'add-nl-mcp-access-2026-10-translations',
    'add-nl-repeating-work-translations',
    'add-nl-ui-complete-2026-10-translations',
];

test('one key, one owner: these catalogues share no key with another add-nl catalogue', () => {
    // Boot order would otherwise decide the wording, and an edit to the losing
    // catalogue would silently never show.
    const clashes = [];
    for (const name of SOLE_OWNER) {
        assert.ok(withTable.includes(name), `${name} is gone or has no table`);
        const mine = new Set(Object.keys(mods.get(name).NL_TRANSLATIONS));
        for (const other of withTable) {
            if (other === name || !other.startsWith('add-nl-')) continue;
            for (const k of Object.keys(mods.get(other).NL_TRANSLATIONS)) if (mine.has(k)) clashes.push(`${name}: ${k} is also in ${other}`);
        }
    }
    assert.deepStrictEqual(clashes, [], 'one key, one owner: boot order would decide the wording');
});

// The loose data migrations that used to carry their own "registered, or it
// never runs" test. bootMigrations.test.js flags a migration file that is
// registered nowhere; this pins that these four sit in the ladder itself
// rather than being merely mentioned by runtime code.
test('these loose migrations are registered in the boot ladder, or they never run', () => {
    for (const name of [
        'memory-extractor-language-2026-10',
        'memory-extractor-sensitivity-2026-10',
        'memory-origin-repair-2026-10',
        'memory-sources-strip-2026-10',
    ]) {
        assert.ok(LOOSE_MIGRATIONS.includes(name), `${name}: add it to LOOSE_MIGRATIONS in boot/bootMigrations.js`);
        assert.strictEqual(typeof require(`./${name}`).up, 'function', `${name} exports no up()`);
    }
});
