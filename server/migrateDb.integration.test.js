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
 * Run: cd server && node --test --test-force-exit migrateDb.integration.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = __dirname;

// supportInboxStore rightly refuses to initialise without the key with which mailbox OAuth tokens
// are encrypted; the suite supplies one.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-session-secret-0123456789abcdef';

// ── Eén pglite-verbinding achter de db.js-facade ────────────────────────────

const { PGlite } = require('@electric-sql/pglite');
const { pgliteQuery } = require('./testUtils/pglitePool');
const pg = new PGlite();

// node-postgres's `query(sql, params)` over this PGlite (testUtils/pglitePool.js).
const rawQuery = pgliteQuery(pg);

const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exportsObj) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exportsObj;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client, end: async () => {} },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try {
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
            throw e;
        }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    getPoolStats: () => ({}),
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

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
after(async () => {
    await pg.close();
});
