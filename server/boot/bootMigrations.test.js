'use strict';

/**
 * Every file in server/migrations/ is accounted for — enforced.
 *
 * The wound this test keeps closed: eleven of the twenty-five add-nl catalogues sat
 * on the shelf for years. No error, no red test — a catalogue that is registered
 * nowhere runs nowhere, and the symptom (a silently English screen) is invisible to
 * whoever built the feature. Six of them were moreover runnable only as a manual
 * script (they ran on require and called process.exit — fatal in a boot ladder).
 *
 * From now on every migration file is exactly one of these things:
 *   1. registered in bootMigrations (LOOSE_MIGRATIONS or NL_TRANSLATIONS),
 *   2. explicitly manual (MANUAL_MIGRATIONS, with a reason),
 *   3. called by runtime code (a store ladder such as
 *      automationStore/core.js, or a route/seed that runs or cites it),
 *   4. absorbed: its DDL has since been folded into the schema of a store
 *      (ABSORBED below, with a verifiable claim).
 * A new file that fits nowhere is a RED TEST with a hint, not a forgotten file.
 *
 * ── And the other way round: NEW columns ────────────────────────────────
 *
 * The `schema_migrations` ledger of bootMigrations.js records only the two lists
 * above; store DDL is not in it. A new column belongs in the idempotent boot DDL of
 * its own store, and then via `runDdl` (stores/lib/_ddl.js) —
 * not in a loose migration file, and not in a `DO $$ … EXCEPTION WHEN
 * OTHERS THEN NULL` block, because that swallows a statement timeout just as hard
 * as "column already exists", and the store then reports itself healthy on a
 * half-built schema.
 * COLUMN_LADDERS below is the verifiable claim per column: the named file exists,
 * names the column, and names it in its runDdl list.
 *
 * Static and DB-free by design, just like migrateDb.registration.test.js:
 * registration is a textual fact; that the ladder really runs and is idempotent is
 * proven by migrateDb.integration.test.js against a real Postgres.
 *
 * Run: cd server && node --test --test-force-exit boot/bootMigrations.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const { LOOSE_MIGRATIONS, NL_TRANSLATIONS, MANUAL_MIGRATIONS } = require('./bootMigrations');

/**
 * Migration files whose DDL has since been folded into the own schema ladder of a
 * store. Each entry is a claim that this test checks itself: the file that names it
 * exists AND still contains the stated marker. If that marker disappears there, the
 * claim is false and the migration belongs in a list again.
 */
const ABSORBED = new Map([
    ['nc-pending-bindings-2026-05', { into: 'stores/user/schemaMigrations.js', marker: 'CREATE TABLE IF NOT EXISTS pending_nc_bindings' }],
    ['nc-pending-bindings-pairing-code-2026-05', { into: 'stores/user/schemaMigrations.js', marker: 'pairing_code' }],
    ['stripe-cancel-and-period-end-2026-05', { into: 'stores/user/planMigrations.js', marker: 'cancel_at_period_end' }],
]);

/**
 * Columns that come through the store ladder instead of through a migration file.
 * Each entry is a claim that this test recalculates: the file exists, the column is
 * in it, and it sits in a `runDdl(...)` call — not in a silent
 * `DO $$ … EXCEPTION` block next to it.
 *
 * `table` is optional and belongs in whenever the column name is COMMON. `version`
 * exists on summary_templates AND (via a migration file) on skills; without a table
 * name the "no own migration file" test would read those two as the same column and
 * go red on a migration that has nothing to do with this store. The table name turns
 * the claim into a claim about one column of one table — which it always was, and
 * since the A1c round also what the matcher recalculates: the statement that adds the
 * column must name THAT table.
 *
 * `kind: 'table'` is the second form: then the claim is about a TABLE that the ladder
 * creates (`CREATE TABLE IF NOT EXISTS <table>`) and no `column` belongs with it.
 * Any other `kind` is an objection — a claim that you cannot write down fails not,
 * it stays silent.
 */
const COLUMN_LADDERS = [
    // O3: where a Solution comes from. Soft reference, no FK — a deleted
    // Blueprint must not take the project with it.
    { column: 'installed_from_blueprint_id', into: 'stores/project/schema.js', tag: 'projectStore' },
    // O4: and what that origin further says. `installed_from_org_id` is
    // the source organisation (established on a gallery install, claimed on a file
    // install) and NEVER decides anything — access comes from blueprintStore.canRead
    // over the real gallery row. `installed_version` gets its table name because that
    // column name is COMMON: it also exists on project_solution_entities.
    { column: 'installed_from_org_id', table: 'projects', into: 'stores/project/schema.js', tag: 'projectStore' },
    { column: 'installed_version', table: 'projects', into: 'stores/project/schema.js', tag: 'projectStore' },
    // The collaborative project workspace: `kind` tells a project from a
    // Studio Solution (NULL = from before the split; the backfill migration
    // only UPDATEs it), and `files_kb_id` names the knowledge base holding the
    // files uploaded into the project. Both come from the store's ladder.
    { column: 'kind', table: 'projects', into: 'stores/project/schema.js', tag: 'projectStore' },
    { column: 'files_kb_id', table: 'projects', into: 'stores/project/schema.js', tag: 'projectStore' },
    // Documents and meeting notes filed into a project: soft references on
    // their own rows, cleared when the project is deleted.
    { column: 'project_id', table: 'studio_documents', into: 'stores/documentStore.js', tag: 'documentStore' },
    { column: 'project_id', table: 'transcriptions', into: 'stores/transcription/schema.js', tag: 'transcriptionStore' },

    // O4: the publication history itself. `kind: 'table'`, because the claim is about
    // a TABLE that the ladder creates and not about a column. The gallery row
    // (project_blueprints) is overwritten on every publication and is therefore a
    // statement about the present; project_releases is what was ever issued, one
    // immutable row per publication with the manifest as published.
    { table: 'project_releases', kind: 'table', into: 'stores/blueprint/schema.js', tag: 'blueprintStore' },
    // M4 step 3: with which template (and which version of it) a note was
    // written. The version belongs to the NOTE and not only to the template, otherwise
    // the screen reads a statement about the past off the present.
    { column: 'version', table: 'summary_templates', into: 'stores/summaryTemplateStore.js', tag: 'summaryTemplateStore' },
    { column: 'summary_template_id', table: 'transcriptions', into: 'stores/transcription/schema.js', tag: 'transcriptionStore' },
    { column: 'summary_template_version', table: 'transcriptions', into: 'stores/transcription/schema.js', tag: 'transcriptionStore' },
    // A1c: de persona-editor en de twee testset-tabellen. Alle drie uit
    // stores/agent/initSchema.js, alle drie zonder eigen migratiebestand.
    { column: 'persona', table: 'agents', into: 'stores/agent/initSchema.agents.js', tag: 'agentSchema' },
    { table: 'agent_tests', kind: 'table', into: 'stores/agent/initSchema.agents.js', tag: 'agentSchema' },
    { table: 'agent_test_runs', kind: 'table', into: 'stores/agent/initSchema.agents.js', tag: 'agentSchema' },
    // A4 part D: WHO wrote the expectation of a test. `written_by` is the
    // per-field provenance from core/agentRuntime/testSuggest.js, `suggested_by`
    // the model that made the suggestion. Both NULL for a test that someone typed
    // themselves — and that distinction is exactly why they are a column and not a
    // key in `expect`: `expect` is what the grader reads, and a provenance field that
    // travelled along in it would become an expectation.
    { column: 'written_by', table: 'agent_tests', into: 'stores/agent/initSchema.agents.js', tag: 'agentSchema' },
    { column: 'suggested_by', table: 'agent_tests', into: 'stores/agent/initSchema.agents.js', tag: 'agentSchema' },
    // BIJT: de invoegvolgorde-teller die `ran_at DESC` als tiebreaker
    // vervangt (stores/agent/agentTests.js) — runs uit dezelfde milliseconde
    // kwamen anders terug in id-volgorde, willekeurig en soms exact omgekeerd.
    { column: 'seq', table: 'agent_test_runs', into: 'stores/agent/initSchema.agents.js', tag: 'agentSchema' },

    // W4: the version list as readable history. `seq` is the number the reader sees
    // (v14) — created_at cannot be that, since that is transaction time.
    // `actor_user_id` is a SOFT reference: a deleted account must not take the page's
    // history with it. `line_delta` is NULL when nothing was measured, and that is
    // something other than 0 lines.
    { column: 'seq', table: 'webpage_versions', into: 'stores/webpage/schema.js', tag: 'webpageSchema' },
    { column: 'actor_user_id', table: 'webpage_versions', into: 'stores/webpage/schema.js', tag: 'webpageSchema' },
    { column: 'line_delta', table: 'webpage_versions', into: 'stores/webpage/schema.js', tag: 'webpageSchema' },

    // M5: de per-vergadering opnamevoorkeur. Eigen tabel, eigen store-ladder,
    // geen migratiebestand.
    { table: 'meeting_prefs', kind: 'table', into: 'stores/meetingPrefsStore.js', tag: 'meetingPrefsStore' },

    // P4 part C: "which button runs this automation". The mirror of
    // automation_datatable_usage, and deliberately its OWN table: that index is keyed
    // per table target (`datatable_id … REFERENCES datatables(id)`), so an app→automation
    // row has no value for it and the INSERT would write zero rows and call itself
    // successful. Own store, own ladder, no migration file.
    { table: 'automation_usage', kind: 'table', into: 'stores/automationUsageStore.js', tag: 'automationUsageStore' },
    // The THIRD answer of that same index: "this app has never been indexed".
    // `automation_usage` can only show rows, and zero rows there means both "no button
    // at all" and "never looked" — on the day of rollout the second is true for EVERY
    // existing app. This tracking table makes the two separable and is at the same time
    // the work list of the backfill. Same store, same ladder, same tag: one runDdl block.
    { table: 'automation_usage_indexed', kind: 'table', into: 'stores/automationUsageStore.js', tag: 'automationUsageStore' },
];

function migrationNames() {
    return fs.readdirSync(path.join(SERVER, 'migrations'))
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map((f) => f.slice(0, -3))
        .sort();
}

/**
 * All non-test runtime source outside migrations/ and the ladder itself: that is where
 * the wiring of store ladders (automationStore/core.js MIGRATIONS, studioAppStore,
 * knowledgeBases) and of seeds/routes lives. bootMigrations.js and migrateDb.js
 * deliberately do not count here — otherwise "is in the list" and "is run by code"
 * would be the same fact.
 */
function runtimeSources() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === 'migrations') continue;
                walk(p);
                continue;
            }
            if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
            if (p === path.join(SERVER, 'migrateDb.js') || p === path.join(__dirname, 'bootMigrations.js')) continue;
            out.push(fs.readFileSync(p, 'utf8'));
        }
    };
    for (const dir of ['stores', 'core', 'routes', 'modules', 'automation', 'boot']) {
        const p = path.join(SERVER, dir);
        if (fs.existsSync(p)) walk(p);
    }
    for (const e of fs.readdirSync(SERVER, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js') && e.name !== 'migrateDb.js') {
            out.push(fs.readFileSync(path.join(SERVER, e.name), 'utf8'));
        }
    }
    return out;
}

test('elk migratiebestand is geregistreerd, handmatig, opgenomen, of door runtime-code bedraad', () => {
    const accounted = new Set([...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS, ...MANUAL_MIGRATIONS, ...ABSORBED.keys()]);
    const sources = runtimeSources();
    const orphans = migrationNames()
        .filter((n) => !accounted.has(n))
        .filter((n) => !sources.some((src) => src.includes(n)));
    assert.deepStrictEqual(orphans, [],
        'deze migraties draaien nergens en zijn nergens verantwoord.\n' +
        'Zet ze in LOOSE_MIGRATIONS of NL_TRANSLATIONS (boot/bootMigrations.js) als ze bij\n' +
        'elke boot horen te draaien, in MANUAL_MIGRATIONS als een operator ze bewust met de\n' +
        'hand draait, of in ABSORBED in deze test als hun DDL in een store-schema is gevouwen.');
});

test('geen naam staat in twee categorieën tegelijk', () => {
    // Two lists that run the same migration is duplicate work; a name that is
    // both manual AND automatic is a contradiction in the contract.
    const lists = { LOOSE_MIGRATIONS, NL_TRANSLATIONS, MANUAL_MIGRATIONS, ABSORBED: [...ABSORBED.keys()] };
    const seen = new Map();
    const dupes = [];
    for (const [list, names] of Object.entries(lists)) {
        for (const n of names) {
            if (seen.has(n)) dupes.push(`${n} (${seen.get(n)} én ${list})`);
            seen.set(n, list);
        }
    }
    assert.deepStrictEqual(dupes, []);
});

test('elke geregistreerde of handmatige naam bestaat op schijf', () => {
    const missing = [...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS, ...MANUAL_MIGRATIONS, ...ABSORBED.keys()]
        .filter((n) => !fs.existsSync(path.join(SERVER, 'migrations', `${n}.js`)));
    assert.deepStrictEqual(missing, [], 'de ladder of een claim noemt een migratie die niet bestaat');
});

test('elke entry die de ladder draait exporteert up() en draait niets bij require', () => {
    // runList does `require(name).up()`. A file without an up export crashes the
    // ladder; a file that starts running on require itself (the old
    // `run().catch(...)` with process.exit) knocks the BOOT flat.
    //
    // Genuinely textual, deliberately: the only way to ACTUALLY try "runs nothing on
    // require" is to require the file — and precisely that is unsafe if the property is
    // broken (a `process.exit()` on require would then end this test process itself,
    // instead of giving one red assertion). The same holds for the up() export: first it
    // must be certain that require is safe before "require it and see whether up() is a
    // function" would be a meaningful behavioural alternative.
    for (const n of [...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS]) {
        const src = fs.readFileSync(path.join(SERVER, 'migrations', `${n}.js`), 'utf8');
        assert.match(src, /module\.exports\s*=\s*\{\s*up\b|module\.exports\.up\s*=/,
            `${n}: exporteert geen up() — runList kan hem niet draaien`);
        const bare = src
            .replace(/if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{[\s\S]*?\n\}/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(!/^\s*(up|run)\s*\(\s*\)/m.test(bare),
            `${n}: roept zichzelf bij require aan — zet de aanroep achter een require.main-guard`);
    }
});

test('elke ABSORBED-claim klopt nog', () => {
    for (const [name, { into, marker }] of ABSORBED) {
        const p = path.join(SERVER, into);
        assert.ok(fs.existsSync(p), `${name}: opnemend bestand ${into} bestaat niet meer`);
        assert.ok(fs.readFileSync(p, 'utf8').includes(marker),
            `${name}: ${into} bevat "${marker}" niet meer — de opname-claim is vals, registreer de migratie alsnog`);
    }
});

/**
 * ── The matcher behind COLUMN_LADDERS ─────────────────────────────────────
 *
 * Pulled out of the test because a matcher that cannot EXPRESS a claim does not
 * fail — it stays silent, and then the list guards exactly those additions not
 * that are new enough to deserve guarding. It is now itself tested
 * (see the matcher tests at the bottom of this file).
 *
 * An entry claims ONE schema addition:
 *
 *   { column, table?, into, tag }            — a COLUMN in the ladder
 *   { table, kind: 'table', into, tag }      — a TABLE that the ladder creates
 *
 * `kind: 'table'` exists because `agent_tests` and `agent_test_runs` are not columns:
 * their addition is a CREATE TABLE, and "the name is in the block" would also be true of
 * an index or an FK that merely NAMES the table. The claim is that the ladder CREATES it.
 */

/**
 * Index of the closing character that belongs to the opening character at `open`, or -1.
 *
 * Strings (', " and `) and comments do not count: the SQL in these files is full of
 * brackets (`agent_conversations(user_id)`) and the Dutch comment lines are full of
 * apostrophes. Without that distinction the scanner would count the contents of a
 * statement as code.
 */
function matchDelimiter(src, open) {
    const OPEN = src[open];
    const CLOSE = { '(': ')', '[': ']' }[OPEN];
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            i = src.indexOf('\n', i);
            if (i < 0) return -1;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            if (e < 0) return -1;
            i = e + 1;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
            if (j >= src.length) return -1;
            i = j;
            continue;
        }
        if (c === OPEN) depth++;
        else if (c === CLOSE && --depth === 0) return i;
    }
    return -1;
}

/**
 * EVERY `runDdl('<tag>', …)` call in a source, as text.
 *
 * Two things were wrong here, and together they made the A1c claims impossible to write
 * down:
 *
 *   1. Only the FIRST call was looked at (`indexOf`). A tag is per store, not per call —
 *      stores/agent/initSchema.js has ten of them under 'agentSchema' — so everything past
 *      the first was read as "stands outside the ladder".
 *   2. The block was cut off at the first `]);`. That is not the end of the call: the
 *      flatMap block closes with `]));` and therefore ran on into the next block, while a
 *      block that ends that way stopped exactly one line too early.
 *
 * Therefore it is now the CALL itself, from `(` to the matching `)` — that is by definition
 * everything that is handed to runDdl, however it is built up.
 */
function runDdlCalls(src, tag) {
    const needle = `runDdl('${tag}'`;
    const out = [];
    for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + needle.length)) {
        const open = at + 'runDdl'.length;
        const close = matchDelimiter(src, open);
        if (close > open) out.push(src.slice(open, close + 1));
    }
    return out;
}

/**
 * The source without comments.
 *
 * A MENTION in a `//` or `/* *\/` comment counted as proof that the ladder makes the
 * column: `knowledge_base_ids` appears in a note INSIDE the same runDdl block, so if you
 * deleted the real ALTER, the claim stayed green on the comment that was about it.
 * A comment does not create a column.
 */
function stripComments(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** De losse DDL-statements in een blok: de template-literals die erin staan. */
function ddlStatements(block) {
    const out = [];
    const re = /`([^`]*)`/g;
    let m;
    while ((m = re.exec(block))) out.push(m[1]);
    return out;
}

/** Waar één entry over gaat, als regex. Zie de kop hierboven voor de vormen. */
function claimNeedle({ column, table, kind }) {
    return kind === 'table'
        ? new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\b`)
        // Op WOORD, niet op substring: `version` mag niet matchen op
        // `published_version`.
        : new RegExp(`\\b${column}\\b`);
}

function claimLabel({ column, table, kind }) {
    if (kind === 'table') return `tabel ${table}`;
    return table ? `${column} (${table})` : `${column}`;
}

/**
 * The objections to one ladder claim. Empty = the claim holds.
 *
 * Everything that cannot be checked is an OBJECTION — never silence. An entry that
 * names nothing, an `into` that cannot be read and a tag without a call differ in
 * message but not in outcome: none of the three is a green claim.
 */
function ladderProblems(entry) {
    const { column, table, into, tag, kind } = entry || {};
    const label = claimLabel(entry || {});

    if (kind !== undefined && kind !== 'table') return [`${label}: onbekende kind '${kind}'`];
    if (kind === 'table' ? !table : !column) {
        return [`${JSON.stringify(entry)}: noemt geen kolom (of geen tabel bij kind: 'table')`];
    }
    if (!into || !tag) return [`${label}: mist into of tag`];

    let raw;
    try {
        raw = fs.readFileSync(path.join(SERVER, into), 'utf8');
    } catch (e) {
        // Missing and unreadable are different values — hence the code in the
        // message — but neither of them means "holds".
        return [`${label}: ${into} is niet te lezen (${e.code || e.message})`];
    }
    // A comment does not count: a mention in an explanatory note is not DDL.
    const src = stripComments(raw);

    const problems = [];
    const needle = claimNeedle(entry);
    if (!needle.test(src)) problems.push(`${label}: staat niet meer in ${into}`);
    if (!/require\(['"][^'"]*_ddl['"]\)/.test(raw)) {
        problems.push(`${into}: importeert stores/lib/_ddl.js niet meer`);
    }

    // The addition MUST be INSIDE a runDdl call with this tag. An
    // ADD COLUMN that moves back into a `DO $$ … EXCEPTION WHEN OTHERS THEN NULL`
    // reads as "already existed" on every error — precisely the silence that U5 abolished.
    const blocks = runDdlCalls(src, tag);
    if (!blocks.length) return [...problems, `${into}: geen runDdl('${tag}', …)-aanroep meer`];
    // And in the SAME statement as the table. A column claim without that requirement
    // says nothing about WHICH table gets the column: `agents.persona` stayed green when the
    // ALTER moved to `agent_conversations`, because that table is in the same block.
    // The header of COLUMN_LADDERS promises the opposite.
    const statements = blocks.flatMap(ddlStatements);
    const fits = (st) => needle.test(st) && (kind === 'table' || !table || st.includes(table));
    if (!statements.some(fits)) {
        problems.push(`${label}: staat in ${into}, maar buiten het runDdl('${tag}')-blok`
            + (table && kind !== 'table' ? ` dat ${table} noemt` : '')
            + ' — daar wordt een echte fout weer stil');
    }
    return problems;
}

/**
 * Migration files that ALSO do the same addition. Two places that add the same
 * column are two places that drift apart.
 *
 * If a column claim has a `table`, a migration only counts once it also names THAT
 * table — two tables may have the same column name.
 */
function migrationsClaiming(entry) {
    const { table, kind } = entry;
    const needle = claimNeedle(entry);
    return migrationNames().filter((n) => {
        const src = fs.readFileSync(path.join(SERVER, 'migrations', `${n}.js`), 'utf8');
        if (kind === 'table') return needle.test(src);
        if (!src.includes('ADD COLUMN') || !needle.test(src)) return false;
        return table ? src.includes(table) : true;
    });
}

test('elke nieuwe kolom staat in de runDdl-ladder van zijn eigen store', () => {
    for (const entry of COLUMN_LADDERS) {
        assert.deepStrictEqual(ladderProblems(entry), [],
            `${entry.column || entry.table}: de ladderclaim klopt niet meer`);
    }
});

test('een kolom uit COLUMN_LADDERS krijgt géén eigen migratiebestand', () => {
    // Two places that add the same column are two places that drift apart,
    // and the migration ladder is precisely what must not grow here.
    //
    // The comparison is on WORD, not on substring: `version` would otherwise match on
    // `published_version`, and then the test reports a collision that is not there.
    // If a `table` is included, a migration only counts once it also names THAT table —
    // two tables may have the same column name.
    for (const entry of COLUMN_LADDERS) {
        assert.deepStrictEqual(migrationsClaiming(entry), [],
            `${claimLabel(entry)}: hoort in de store-ladder, niet ook in een migratiebestand`);
    }
});

// ── A1c: the three schema additions that do NOT YET have a claim ──────────────
//
// `agents.persona` and the two testset tables all three come from
// stores/agent/initSchema.js and are on no list at all. They belong in
// COLUMN_LADDERS above; that list is being placed by the main session.
// What stands HERE is the SHAPE, because that is what was broken: the matcher could not
// express these three claims, and a claim that you cannot write down does not fail — it
// stays silent. Once the three lines are in COLUMN_LADDERS, the ladder test covers them
// substantively and this fixture pins only the shape.
// initSchema.js is a facade since LF-S3: the DDL lives in .base.js + .agents.js,
// run in the same order. The agent_* / persona claims are all in .agents.js.
const INIT_SCHEMA = 'stores/agent/initSchema.agents.js';
const INIT_SCHEMA_BASE = 'stores/agent/initSchema.base.js'; // conversation columns, agents CREATE TABLE
const INIT_SCHEMA_PARTS = [INIT_SCHEMA_BASE, INIT_SCHEMA];

// NOT a second copy: a filter OVER the guarded list. As a separate fixture this would be
// a second list with the same three claims, and then nothing changes in the outcome when
// they disappear from COLUMN_LADDERS — the matcher tests here would stay green on their
// own copy while the guarded list emptied.
const A1C_LADDERS = COLUMN_LADDERS.filter((e) => e.into === INIT_SCHEMA);
// The whole DDL module set as one unit, in ladder order (base first, then agents).
const readInitSchema = () => INIT_SCHEMA_PARTS.map((f) => fs.readFileSync(path.join(SERVER, f), 'utf8')).join('\n');

test('de matcher vindt een kolom in een LATER runDdl-blok met dezelfde tag', () => {
    // The wound: the block was delimited at the FIRST `runDdl('<tag>'` in the file, and that
    // tag is not unique — stores/agent/initSchema.js has ten of them under 'agentSchema'.
    // `persona` is in the seventh. The matcher therefore read it as "stands outside the
    // ladder", and the claim was not writable: a column that actually stood there correctly
    // could not come out green.
    const src = readInitSchema();

    // Genuinely textual, deliberately: this is not a claim about behaviour but the
    // PREMISE that makes the behavioural assertion below meaningful — that the real,
    // growing source still contains the tag twice and `persona` still stands beyond the
    // first block. If that premise disappears (someone rearranges initSchema.js), then
    // THIS rule must go red — otherwise the matcher test below silently becomes vacuous
    // on a fixture that no longer exists.
    const tagAt = [...src.matchAll(/runDdl\('agentSchema'/g)].map((m) => m.index);
    assert.ok(tagAt.length > 1, 'premisse: de tag agentSchema komt meer dan één keer voor');
    assert.ok(src.indexOf('persona JSONB') > tagAt[1],
        'premisse: persona staat voorbij het eerste runDdl-blok');

    // And this is what the matcher must be able to express.
    assert.deepStrictEqual(ladderProblems(A1C_LADDERS[0]), []);
});

test('de matcher bakent élk runDdl-blok van een gedeelde tag af', () => {
    const src = readInitSchema();
    const blocks = runDdlCalls(src, 'agentSchema');
    // Genuinely textual: this recalculates runDdlCalls() (the matcher) against an independent
    // count of the same source, not against what the matcher itself claims — hence the direct
    // regex on `src` next to the call.
    assert.strictEqual(blocks.length, (src.match(/runDdl\('agentSchema'/g) || []).length,
        'elk voorkomen van de tag hoort één blok op te leveren');

    // The flatMap block is the second reason that delimiting on ']);' does not suffice:
    // that block closes with ']));' and therefore ran on far into the NEXT block — a column
    // from block 7 then read as a column from block 6.
    assert.ok(blocks.some((b) => b.includes('flatMap') && b.includes('shared_scope')),
        'het flatMap-blok hoort compleet te zijn, niet afgekapt op zijn eerste ]');
});

test('de matcher kan een CREATE TABLE in de ladder uitdrukken', () => {
    // agent_tests and agent_test_runs are TABLES. The old record form knew only
    // `column` + `src.includes(column)`; with that, "this ladder makes this table"
    // cannot be expressed.
    for (const entry of A1C_LADDERS.filter((e) => e.kind === 'table')) {
        assert.deepStrictEqual(ladderProblems(entry), [], `${entry.table}: claim klopt niet`);
    }
});

test('de drie A1c-claims botsen met geen enkel migratiebestand', () => {
    // The other side of the same claim: if these three are later in COLUMN_LADDERS, the
    // "no own migration file" test must also stay green. For a table claim that is a CREATE
    // TABLE elsewhere, not an ADD COLUMN.
    for (const entry of A1C_LADDERS) {
        assert.deepStrictEqual(migrationsClaiming(entry), [],
            `${claimLabel(entry)}: hoort in de store-ladder, niet ook in een migratiebestand`);
    }
});

test('elke claim op de agent-ladder staat in de BEWAAKTE lijst, niet alleen in deze fixture', () => {
    // The finding itself: as long as they stood only here, nothing guarded
    // `agents.persona`, `agent_tests` and `agent_test_runs`. This assertion is
    // what makes "forgot to paste" red — and it ALSO counts, so that a NEW column on this
    // ladder must become visible here instead of quietly riding along on the three that
    // were already there.
    const want = [
        { column: 'persona', table: 'agents', into: INIT_SCHEMA, tag: 'agentSchema' },
        { table: 'agent_tests', kind: 'table', into: INIT_SCHEMA, tag: 'agentSchema' },
        { table: 'agent_test_runs', kind: 'table', into: INIT_SCHEMA, tag: 'agentSchema' },
        // A4 deel D: de herkomst van een verwachting die een model schreef.
        { column: 'written_by', table: 'agent_tests', into: INIT_SCHEMA, tag: 'agentSchema' },
        { column: 'suggested_by', table: 'agent_tests', into: INIT_SCHEMA, tag: 'agentSchema' },
        // Deterministische testrun-volgorde: de invoegvolgorde-teller die
        // ran_at DESC als tiebreaker vervangt (zie stores/agent/agentTests.js).
        { column: 'seq', table: 'agent_test_runs', into: INIT_SCHEMA, tag: 'agentSchema' },
    ];
    for (const entry of want) {
        assert.ok(
            COLUMN_LADDERS.some((e) => JSON.stringify(e) === JSON.stringify(entry)),
            `${claimLabel(entry)}: hoort in COLUMN_LADDERS te staan — anders bewaakt niets hem`,
        );
    }
    assert.strictEqual(A1C_LADDERS.length, want.length,
        'en de fixture hierboven is een FILTER over die lijst, geen tweede kopie');
});

test('een noeming in COMMENTAAR is geen kolom', () => {
    // The widening from "first block" to "every block" made this reachable:
    // `knowledge_base_ids` also appears in a note inside the same runDdl block, so if you
    // deleted the ALTER, the claim stayed green on the comment that was about it.
    const src = readInitSchema();
    // Genuinely textual, same reason as the two tests above: this is the
    // premise that stripComments() below tests meaningfully, not a claim about production
    // behaviour — if `knowledge_base_ids` ever disappears from the comment in initSchema.js,
    // THIS rule must report it instead of letting the stripComments test quietly run empty.
    assert.ok(/\/\/[^\n]*knowledge_base_ids/.test(src),
        'premisse: de kolom wordt in dit bestand ook in commentaar genoemd');
    const stripped = stripComments(src);
    assert.ok(!/\/\/[^\n]*knowledge_base_ids/.test(stripped), 'en dat commentaar is weg');
    assert.ok(stripped.includes("ADD COLUMN IF NOT EXISTS knowledge_base_ids"),
        'terwijl de echte ALTER blijft staan');
});

test('een kolomclaim gaat over ÉÉN tabel — een andere tabel in hetzelfde blok telt niet', () => {
    // `pinned` is in the same runDdl block as `knowledge_base_ids`, but on two OTHER
    // tables. A claim that puts `pinned` on `agents` should therefore be red, even though the
    // word stands in the ladder.
    const out = ladderProblems({
        column: 'pinned', table: 'agents', into: INIT_SCHEMA_BASE, tag: 'agentSchema',
    });
    assert.ok(out.some((m) => m.includes('agents')),
        `een kolom van een andere tabel hoort een bezwaar te geven, kreeg: ${JSON.stringify(out)}`);
    // En de tabel waar hij WEL op staat blijft groen.
    assert.deepStrictEqual(ladderProblems({
        column: 'pinned', table: 'direct_conversations', into: INIT_SCHEMA_BASE, tag: 'agentSchema',
    }), []);
});

test('de matcher blijft rood op een kolom buiten elke runDdl-ladder', () => {
    // starter_prompts is in the CREATE TABLE that runs via exec() — precisely what this claim
    // must NOT cover. Widening "first block" to "every block" must not overshoot into "stands
    // somewhere in the file".
    const out = ladderProblems({
        column: 'starter_prompts', table: 'agents', into: INIT_SCHEMA_BASE, tag: 'agentSchema',
    });
    assert.ok(out.some((m) => m.includes('buiten het runDdl')),
        `een kolom buiten de ladder hoort een bezwaar te geven, kreeg: ${JSON.stringify(out)}`);
});

test('de matcher blijft rood op een tabel die de ladder alleen NOEMT', () => {
    // agent_favorites is created with exec(); the runDdl block beneath it only places an
    // index on it. "Is mentioned" is not "is created" — otherwise the claim covers a table whose
    // creation could still fail silently.
    const out = ladderProblems({ table: 'agent_favorites', kind: 'table', into: INIT_SCHEMA, tag: 'agentSchema' });
    assert.ok(out.length > 0, 'een genoemde-maar-niet-gemaakte tabel hoort een bezwaar te geven');
});

test('onbekend versmalt: een onleesbaar doel of een lege claim is een bezwaar', () => {
    // None of these may drop out as "holds". A claim that says nothing
    // is not a green claim.
    const cases = [
        ['bestand weg', { column: 'persona', into: 'stores/agent/bestaat-niet.js', tag: 'agentSchema' }, 'niet te lezen'],
        ['kolom weg', { column: 'nooit_bestaan_hebbende_kolom', into: INIT_SCHEMA, tag: 'agentSchema' }, 'staat niet meer in'],
        ['tag weg', { column: 'persona', into: INIT_SCHEMA, tag: 'geenEnkeleTag' }, 'geen runDdl'],
        // The three that did NOT cover their own gate: each of these came out red only
        // because `claimNeedle({})` happened to land on `/\bundefined\b/`, and that word
        // appears nowhere in the ladder. Put `undefined` in a comment line and a claim that
        // names NOTHING would read as green. Therefore now on the MESSAGE, not on "there was one".
        ['noemt niets', { into: INIT_SCHEMA, tag: 'agentSchema' }, 'noemt geen kolom'],
        ['tabel zonder kind', { table: 'agent_tests', into: INIT_SCHEMA, tag: 'agentSchema' }, 'noemt geen kolom'],
        ['onbekende kind', { column: 'persona', kind: 'index', into: INIT_SCHEMA, tag: 'agentSchema' }, 'onbekende kind'],
        ['into weg', { column: 'persona', table: 'agents', tag: 'agentSchema' }, 'mist into of tag'],
        ['tag ontbreekt', { column: 'persona', table: 'agents', into: INIT_SCHEMA }, 'mist into of tag'],
        ['allebei weg', { column: 'persona', table: 'agents' }, 'mist into of tag'],
    ];
    for (const [label, entry, want] of cases) {
        const out = ladderProblems(entry);
        assert.ok(out.length > 0, `${label}: hoort een bezwaar te geven, gaf er geen`);
        assert.ok(out.some((m) => m.includes(want)),
            `${label}: het bezwaar hoort "${want}" te noemen, kreeg: ${JSON.stringify(out)}`);
    }

    // The word boundary is load-bearing: without it a claim would match on a PART of a
    // column name, and then "persona" would also cover "geen_persona_hier".
    assert.ok(ladderProblems({ column: 'ersona', table: 'agents', into: INIT_SCHEMA, tag: 'agentSchema' })
        .some((m) => m.includes('staat niet meer in')),
        'een halve kolomnaam hoort geen claim te zijn');
});
