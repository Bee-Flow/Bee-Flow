'use strict';

/**
 * `npm run db:migrate`, END TO END, against a real Postgres.
 *
 * The old runner was caught empirically (PLAN-APP-UPGRADE.md): it reported
 * "All stores migrated successfully" while not a single CREATE TABLE had been awaited — and after a run
 * `agents`, `direct_conversations` and `integration_activity_log`, among others, were missing, because
 * their owners initialise lazily or simply were not on the list. This suite runs the REAL ladder
 * (runMigrations: user_sessions → every store awaited → separate data migrations → NL catalogues)
 * and checks the ground truth in information_schema, instead of believing the log lines.
 *
 * ── WHY pglite ──────────────────────────────────────────────────────
 * Same reasoning and same db.js facade as stores/datatableDbStore.integration.test.js:
 * @electric-sql/pglite is real Postgres (WASM, in-process, already a devDependency), so this suite
 * ALWAYS runs — no container, no self-skip. pgvector is missing in pglite; that is a feature here,
 * because it immediately proves that knowledgeStore's documented degradation (keyword search without
 * vector) does not break the ladder.
 *
 * The second test is the idempotence requirement from the upgrade contract: the store DDL runs
 * again on every boot — running twice must give zero errors and zero new tables. The last tests
 * prove the `schema_migrations` ledger of the boot ladder: registering, skipping, running again when
 * a file has changed, and --force.
 *
 * The account-erasure footprint rides the same ladder (bottom of this file):
 * with every table in place, deleteUser is held against the whole schema.
 *
 * Run: cd server && node --test --test-force-exit migrateDb.integration.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// One PGlite behind the db.js facade (testUtils/pgliteLadderDb.js installs
// the mock, so it must come before any store is required).
const { usePgliteLadder } = require('./testUtils/pgliteLadderDb');
const { pg, rawQuery } = usePgliteLadder();

// Alles hieronder is het echte spul.
const { runMigrations } = require('./migrateDb');

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

async function tableNames() {
    const r = await rawQuery(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    return new Set(r.rows.map((x) => x.table_name));
}

let firstReport = null;
let tablesAfterFirst = null;

test('de ladder draait echt: nul fouten, en de bewezen-missende tabellen bestaan', async () => {
    firstReport = await runMigrations({ log: quiet });

    assert.deepStrictEqual(
        firstReport.failed.map((f) => `${f.name}: ${f.error}`), [],
        'geen enkel ladderonderdeel mag falen');
    assert.deepStrictEqual(firstReport.unverified, [],
        'elke store hoort een awaitbare initDB()/ready te hebben — "geladen maar niet geverifieerd" is het oude liegen');

    tablesAfterFirst = await tableNames();
    // The ground truth, not the log line. These are precisely the absentees from
    // the empirical evidence, plus a cross-section through the fleet.
    for (const t of [
        'user_sessions', 'users', 'agents', 'agent_conversations', 'direct_conversations',
        'integration_activity_log', 'automations', 'automation_runs',
        'cowork_schedules', 'cowork_runs', 'notebook_sources', 'knowledge_bases',
        'studio_apps', 'support_threads',
    ]) {
        assert.ok(tablesAfterFirst.has(t), `tabel ontbreekt na migratie: ${t}`);
    }
});

test('twee keer draaien is een no-op: nul fouten, nul nieuwe tabellen', async () => {
    assert.ok(firstReport, 'eerste run moet gelopen hebben');
    const second = await runMigrations({ log: quiet });
    assert.deepStrictEqual(second.failed.map((f) => `${f.name}: ${f.error}`), [],
        'een al-gemigreerde database hoort een schone tweede run te geven');
    const tablesAfterSecond = await tableNames();
    assert.deepStrictEqual([...tablesAfterSecond].sort(), [...tablesAfterFirst].sort(),
        'de tweede run mag het schema niet veranderen');
});

test('gecureerde wording overleeft de ladder — de belofte uit elke catalogusheader', async () => {
    // Every add-nl-header promises "a workspace that keeps its own wording curated". That behaviour has been
    // in languageStore.addMissingGUITranslations since U6 (atomic via mutateConfig);
    // here it is proven through the REAL ladder, not by poking the helper in isolation.
    const languageStore = require('./stores/languageStore');
    const before = await languageStore.getGUITranslations('nl');
    assert.strictEqual(before['datatables.title'], 'Datatabellen',
        'de catalogus hoort deze sleutel gezaaid te hebben');

    await languageStore.setGUITranslations('nl', { ...before, 'datatables.title': 'Mijn tabellen' });
    // --force: without bypassing the ledger the catalogue would be skipped and
    // this test would prove nothing.
    const third = await runMigrations({ log: quiet, force: true });
    assert.deepStrictEqual(third.failed, [], 'de derde run hoort schoon te zijn');

    const after = await languageStore.getGUITranslations('nl');
    assert.strictEqual(after['datatables.title'], 'Mijn tabellen',
        'de ladder heeft een door de beheerder gecureerde vertaling overschreven');
});

// ── De ledger ───────────────────────────────────────────────────────────────

const { LOOSE_MIGRATIONS, NL_TRANSLATIONS, LEDGER_TABLE } = require('./boot/bootMigrations');
const LADDER = [...LOOSE_MIGRATIONS, ...NL_TRANSLATIONS];
const isLadder = (n) => n.startsWith('datamigraties/') || n.startsWith('NL-catalogi/');

test('de eerste run registreert elke boot-migratie met de checksum van haar bestand', async () => {
    const rows = (await rawQuery(`SELECT name, checksum, applied_at FROM ${LEDGER_TABLE}`)).rows;
    const names = new Set(rows.map((r) => r.name));
    for (const n of LADDER) assert.ok(names.has(n), `niet geregistreerd: ${n}`);
    for (const r of rows) {
        assert.match(r.checksum, /^[0-9a-f]{64}$/, `${r.name}: geen sha256 als checksum`);
        assert.ok(r.applied_at, `${r.name}: geen applied_at`);
    }
});

test('een geregistreerde migratie wordt overgeslagen, en --force draait haar opnieuw', async () => {
    const again = await runMigrations({ log: quiet });
    assert.deepStrictEqual(again.failed, []);
    assert.strictEqual(again.skipped.length, LADDER.length, 'elke geregistreerde boot-migratie hoort overgeslagen te worden');
    assert.deepStrictEqual(again.succeeded.filter(isLadder), [], 'een geregistreerde migratie draaide toch');

    const forced = await runMigrations({ log: quiet, force: true });
    assert.deepStrictEqual(forced.failed, []);
    assert.deepStrictEqual(forced.skipped, []);
    assert.strictEqual(forced.succeeded.filter(isLadder).length, LADDER.length, '--force hoort de hele ladder te draaien');
});

test('een migratiebestand dat veranderde sinds de registratie draait opnieuw en wordt herregistreerd', async () => {
    const name = LOOSE_MIGRATIONS[0];
    await rawQuery(`UPDATE ${LEDGER_TABLE} SET checksum = 'stale' WHERE name = $1`, [name]);

    const r = await runMigrations({ log: quiet });
    assert.deepStrictEqual(r.failed, []);
    assert.ok(r.succeeded.includes(`datamigraties/${name}`), 'het gewijzigde bestand hoort opnieuw te draaien');
    assert.strictEqual(r.skipped.length, LADDER.length - 1, 'alleen het gewijzigde bestand hoort te draaien');

    const row = (await rawQuery(`SELECT checksum FROM ${LEDGER_TABLE} WHERE name = $1`, [name])).rows[0];
    assert.match(row.checksum, /^[0-9a-f]{64}$/, 'de registratie hoort de actuele checksum weer te dragen');
});

// pglite is a real Postgres in-process, so it holds handles until it is told
// to let go. Without this the file's tests all pass and the process then never
// exits — which the runner now reports as HUNG instead of silently cutting the
// whole suite's results short. Same close as the sibling suite this file's
// header points at, stores/datatableDbStore.integration.test.js:170.

// ═══════════════════════════════════════════════════════════════════════════
// Account erasure against the WHOLE schema (stores/user/usersDelete.js,
// erasureCoverage.js, erasure-exemptions.json).
//
// Two promises, both held against the real schema the ladder just built:
//
//   1. The footprint guard. Every table that can name a person (the catalog
//      discovery of scripts/lib/userDataFootprint.js: owner columns plus FKs
//      to users) is either handled by erasureCoverage.js or listed with its
//      reason in erasure-exemptions.json. A feature that adds a per-user table
//      and forgets deleteUser fails here, which is the whole point: a
//      hand-kept cascade is only as complete as the last person who checked
//      it against the schema.
//
//   2. The cascade itself. A user with a conversation and its messages, a
//      meeting note, a web page, an app, a routine with a schedule and a run,
//      a skill, and references on a colleague's risk register and project is
//      deleted; the content is gone, the organisation's records remain and
//      no longer name the person.
// ═══════════════════════════════════════════════════════════════════════════

const { discoverUserTables } = require('./scripts/lib/userDataFootprint');
const { ERASURE_COVERAGE, entriesOf } = require('./stores/user/erasureCoverage');
/** @type {Record<string, string>} */
const exemptions = JSON.parse(fs.readFileSync(path.join(__dirname, 'stores', 'user', 'erasure-exemptions.json'), 'utf8'));

const db = { query: rawQuery };
/** @type {Array<{ table: string, columns: string[] }>} */
let discovered = [];

// Read once, from the first erasure test on: the ladder tests above have
// built the schema by then (a top-level before() would run too early).
async function userTables() {
    if (!discovered.length) discovered = await discoverUserTables(db);
    return discovered;
}

/** @param {string} table @param {string} column */
async function columnInfo(table, column) {
    const { rows } = await rawQuery(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column]);
    return rows[0] || null;
}

test('every user-keyed table in the schema is covered by erasureCoverage.js or exempted with a reason', async () => {
    const discovered = await userTables();
    const covered = new Set(Object.keys(ERASURE_COVERAGE));
    const exempt = new Set(Object.keys(exemptions).filter((k) => !k.startsWith('_')));
    const missing = discovered.filter(({ table }) => !covered.has(table) && !exempt.has(table))
        .map(({ table, columns }) => `${table}(${columns.join(',')})`);
    assert.deepStrictEqual(missing, [],
        'these tables can hold a person\'s data and deleteUser does nothing about them: add them to erasureCoverage.js, or to erasure-exemptions.json with the reason');
    const both = [...exempt].filter((t) => covered.has(t));
    assert.deepStrictEqual(both, [], 'a table is covered or exempted, not both');
});

test('every covered or exempted table exists, and the columns the generic steps use are real (and nullable where cleared)', async () => {
    const discovered = await userTables();
    // The generic steps and the exemptions name user-keyed tables; a `step`
    // or `cascade` entry may document a table the discovery does not see
    // (its owner column has another name, or it only has a parent key).
    const present = new Set(discovered.map((t) => t.table));
    const generic = [...entriesOf('deleted'), ...entriesOf('detached'), ...entriesOf('reassigned')];
    const stale = [...generic.map(([t]) => t), ...Object.keys(exemptions).filter((k) => !k.startsWith('_'))]
        .filter((t) => !present.has(t));
    assert.deepStrictEqual(stale, [], 'named in the erasure map or the exemptions but no longer a user-keyed table in the schema');

    /** @type {string[]} */
    const problems = [];
    for (const [table, entry] of generic) {
        const cleared = entry.mode === 'detached' ? entry.column.split(',') : (entry.mode === 'deleted' && entry.detach ? [entry.detach] : []);
        for (const column of [...entry.column.split(','), ...cleared]) {
            const info = await columnInfo(table, column);
            if (!info) { problems.push(`${table}.${column} does not exist`); continue; }
            if (cleared.includes(column) && info.is_nullable !== 'YES') problems.push(`${table}.${column} is NOT NULL and cannot be cleared: reassign it instead`);
        }
    }
    assert.deepStrictEqual(problems, []);
});

test('the owner of every discovered column is handled: a column the discovery names must be the one the step uses', async () => {
    const discovered = await userTables();
    // A table may carry two owner columns (created_by AND owner_user_id); the
    // step has to clear both, or the row keeps naming the person.
    /** @type {string[]} */
    const partial = [];
    for (const { table, columns } of discovered) {
        const entry = ERASURE_COVERAGE[table];
        if (!entry || !('column' in entry)) continue;
        const handled = new Set([...entry.column.split(','), ...(entry.mode === 'deleted' && entry.detach ? [entry.detach] : [])]);
        const left = columns.filter((c) => !handled.has(c));
        if (left.length) partial.push(`${table}: ${left.join(',')}`);
    }
    assert.deepStrictEqual(partial, []);
});

// ── The cascade ─────────────────────────────────────────────────────────

const LEAVER = 'leaver';
const HEIR = 'heir';
const ORG = 'org-erasure';

/** @param {string} sql @param {unknown[]} [params] */
const q = (sql, params) => rawQuery(sql, params);
/** @param {string} table @param {string} column @param {string} [value] */
async function count(table, column, value = LEAVER) {
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [value]);
    return rows[0].n;
}

test('deleting the account erases its content and detaches it from the organisation\'s records', async () => {
    const users = require('./stores/user/users');
    const { resetErasurePortsForTests, registerErasurePorts } = require('./stores/user/erasurePorts');
    resetErasurePortsForTests();
    registerErasurePorts({
        notebooks: { deleteAllForUser: async () => ({ notebooks: 0 }) },
        projects: { makeTeardown: () => ({ deleteProject: async () => true }) },
        // The real content port: the stores under test, as the server registers them.
        content: require('./projects/accountContentErasure'),
    });

    await q(`INSERT INTO organizations (id, name) VALUES ($1, 'Erasure Org')`, [ORG]);
    assert.strictEqual(await users.createUser({ id: HEIR, username: HEIR, passwordHash: '', organizationId: ORG, orgRole: 'org_admin' }), true);
    assert.strictEqual(await users.createUser({ id: LEAVER, username: LEAVER, passwordHash: '', organizationId: ORG }), true);
    // The heir is the oldest admin only when created first; make the order explicit.
    await q(`UPDATE users SET "createdAt" = NOW() - INTERVAL '1 day' WHERE id = $1`, [HEIR]);

    // Chat: a conversation with messages, plus a message the leaver wrote in the heir's conversation.
    await q(`INSERT INTO agents (id, name, owner_id) VALUES ('ag1', 'Agent', $1)`, [HEIR]);
    await q(`INSERT INTO agent_conversations (id, agent_id, user_id) VALUES ('c-leaver', 'ag1', $1), ('c-heir', 'ag1', $2)`, [LEAVER, HEIR]);
    await q(`INSERT INTO conversation_messages (id, conversation_id, role, content, author_user_id, seq) VALUES
             ('m1', 'c-leaver', 'user', 'my secret', $1, 1), ('m2', 'c-leaver', 'assistant', 'reply', NULL, 2),
             ('m3', 'c-heir', 'user', 'in a group chat', $1, 1)`, [LEAVER]);
    // Meeting note, web page, app, skill, routine with a schedule and a run.
    await q(`INSERT INTO transcriptions (id, user_id, organization_id) VALUES ('t1', $1, $2)`, [LEAVER, ORG]);
    await q(`INSERT INTO webpages (id, user_id) VALUES ('w1', $1)`, [LEAVER]);
    await q(`INSERT INTO webpage_versions (id, webpage_id) VALUES ('wv1', 'w1')`);
    await q(`INSERT INTO studio_apps (id, user_id, organization_id) VALUES ('app1', $1, $2)`, [LEAVER, ORG]);
    await q(`INSERT INTO studio_app_attachments (id, app_id, owner_user_id) VALUES ('att1', 'app1', $1)`, [LEAVER]);
    await q(`INSERT INTO skills (id, user_id, name) VALUES ('sk1', $1, 'Skill')`, [LEAVER]);
    await q(`INSERT INTO automations (id, user_id, organization_id, title, definition_json) VALUES ('auto1', $1, $2, 'Routine', '{}'::jsonb)`, [LEAVER, ORG]);
    await q(`INSERT INTO automation_schedules (id, automation_id, trigger_step_id, cron) VALUES ('sch1', 'auto1', 'trig', '0 7 * * *')`);
    await q(`INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind) VALUES ('run1', 'auto1', 1, $1, 'schedule')`, [LEAVER]);
    await q(`INSERT INTO reminders (id, user_id, title, remind_at) VALUES ('r1', $1, 'Call', NOW())`, [LEAVER]);
    // The organisation's records that name the leaver: a risk (nullable
    // author) and an app template (NOT NULL author, handed to the heir).
    await q(`INSERT INTO iso_risks (organization_id, title, created_by, owner_user_id) VALUES ($1, 'Risk', $2, $2)`, [ORG, LEAVER]);
    await q(`INSERT INTO guardrail_events (organization_id, user_id, violation_type) VALUES ($1, $2, 'pii')`, [ORG, LEAVER]);
    // A colleague's project with a task the leaver created: to the project's owner.
    await q(`INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('p1', 'Project', $1, $2)`, [HEIR, ORG]);
    await q(`INSERT INTO project_tasks (id, project_id, title, created_by) VALUES ('task1', 'p1', 'Task', $1)`, [LEAVER]);

    assert.strictEqual(await users.deleteUser(LEAVER), true);

    // Gone with the account.
    assert.strictEqual(await count('users', 'id'), 0);
    assert.strictEqual(await count('agent_conversations', 'user_id'), 0);
    assert.strictEqual(await count('conversation_messages', 'conversation_id', 'c-leaver'), 0, 'the chat content itself');
    assert.strictEqual(await count('transcriptions', 'user_id'), 0);
    assert.strictEqual(await count('webpages', 'user_id'), 0);
    assert.strictEqual(await count('webpage_versions', 'webpage_id', 'w1'), 0);
    assert.strictEqual(await count('studio_apps', 'user_id'), 0);
    assert.strictEqual(await count('studio_app_attachments', 'owner_user_id'), 0);
    assert.strictEqual(await count('skills', 'user_id'), 0);
    assert.strictEqual(await count('automations', 'user_id'), 0);
    assert.strictEqual(await count('automation_schedules', 'automation_id', 'auto1'), 0, 'the schedule goes with the routine');
    assert.strictEqual(await count('automation_runs', 'user_id'), 0);
    assert.strictEqual(await count('reminders', 'user_id'), 0);

    // Kept, without the person.
    assert.strictEqual(await count('conversation_messages', 'conversation_id', 'c-heir'), 1, 'the colleague\'s conversation keeps its message');
    assert.strictEqual(await count('conversation_messages', 'author_user_id'), 0, '...but it no longer names the author');
    assert.strictEqual(await count('iso_risks', 'organization_id', ORG), 1, 'the risk register is the organisation\'s');
    assert.strictEqual(await count('iso_risks', 'created_by'), 0);
    assert.strictEqual(await count('iso_risks', 'owner_user_id'), 0);
    assert.strictEqual(await count('guardrail_events', 'organization_id', ORG), 1);
    assert.strictEqual(await count('guardrail_events', 'user_id'), 0);
    assert.strictEqual(await count('project_tasks', 'created_by'), 0);
    assert.strictEqual(await count('project_tasks', 'created_by', HEIR), 1, 'the task is the project owner\'s now');
});

test('deleting the organisation afterwards leaves no row keyed by it', async () => {
    // The older rungs of the org cascade name tables that stores outside the
    // boot ladder create (group chats, tasks, custom tables, dashboards); on
    // this schema they do not exist and the cascade throws by design. Empty
    // stand-ins, so the rungs under test are reached.
    await q(`CREATE TABLE IF NOT EXISTS group_chats (id TEXT PRIMARY KEY, organization_id TEXT)`);
    await q(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, organization_id TEXT)`);
    await q(`CREATE TABLE IF NOT EXISTS custom_tables (table_name TEXT, organization_id TEXT)`);
    await q(`CREATE TABLE IF NOT EXISTS dashboards (id TEXT PRIMARY KEY, organization_id TEXT)`);
    await q(`CREATE TABLE IF NOT EXISTS dashboard_panels (dashboard_id TEXT)`);
    // A record of a member removed by another path, which only the org cascade can reach.
    await q(`INSERT INTO transcriptions (id, user_id, organization_id) VALUES ('t-orphan', 'gone-member', $1)`, [ORG]);
    await q(`INSERT INTO automations (id, user_id, organization_id, title, definition_json) VALUES ('auto-orphan', 'gone-member', $1, 'Routine', '{}'::jsonb)`, [ORG]);

    const { deleteOrganization } = require('./stores/user/organizations');
    assert.strictEqual(await deleteOrganization(ORG), true);
    for (const table of ['iso_risks', 'guardrail_events', 'transcriptions', 'automations', 'studio_apps', 'playbooks']) {
        assert.strictEqual(await count(table, 'organization_id', ORG), 0, table);
    }
    assert.strictEqual(await count('users', 'id', HEIR), 0);
});

after(async () => {
    require('./stores/user/erasurePorts').resetErasurePortsForTests();
    await pg.close();
});
