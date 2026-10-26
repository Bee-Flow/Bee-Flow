// @typecheck strict
'use strict';

/**
 * Every store schema through ONE ledger, end to end: the real stores, the real
 * db.js (its pool answered by PGlite, testUtils/pglitePool) and the real
 * `npm run db:migrate` (migrateDb.runMigrations). A "boot" after the first is
 * the same process with every store memo forgotten (storeInit._resetAllForTests),
 * which is what a restarted server is to the ledger.
 *
 * Proven:
 *   - a fresh install creates every table, records a ledger unit per store, and
 *     no schema statement of a store init bypasses the ledger (THE GATE: a store
 *     whose DDL runs outside makeStoreInit, or through a raw pool/client query,
 *     is a red test here, with its name);
 *   - an unchanged install, once settled, sends no schema statement at all;
 *   - an existing install whose ledger is empty, holds stale keys, or predates
 *     the store schemas (no DDL columns) upgrades without an error and without
 *     losing a row;
 *   - a statement new to an install runs there (the case the removed probes
 *     missed), a dropped table comes back whole;
 *   - boot (boot/storeSchemas.js) and db:migrate run the same list through the
 *     same ledger.
 *
 * Run: cd server && node --test boot/schemaLedger.integration.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// supportInboxStore refuses to start without the key its tokens are sealed with.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-session-secret-0123456789abcdef';

const SERVER = path.join(__dirname, '..');
const { usePglitePool } = require('../testUtils/pglitePool');
const { pg, query: rawQuery } = usePglitePool();

const db = require('../db');
const ledger = require('../stores/lib/ddlLedger');
const storeInit = require('../stores/lib/storeInit');

// ── the gate's eyes: every statement that reaches the database ──────────────

/** @type {{ unit: string | null, sql: string }[]} */
const bypassed = [];
let watching = false;

/** @param {unknown} sql */
function inspect(sql) {
    const text = typeof sql === 'string' ? sql : String(/** @type {{ text?: string }} */ (sql)?.text || '');
    if (!watching || !ledger.isSchemaOnly(text) || ledger.isInflight(text)) return;
    if (/\bschema_migrations\b/.test(text)) return;   // the ledger's own table
    bypassed.push({ unit: ledger.currentUnit(), sql: text.replace(/\s+/g, ' ').trim().slice(0, 160) });
}
const watched = async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => { inspect(sql); return rawQuery(sql, params); };
db.pool.query = /** @type {any} */ (watched);
db.pool.connect = /** @type {any} */ (async () => ({ query: watched, release() {} }));

/**
 * Schema statements that may reach the database during the store phase
 * without the ledger, each with the reason. Matched on the statement text.
 */
const OUTSIDE_THE_LEDGER = [
    // migrateDb.js pre-creates connect-pg-simple's table itself; it is no store.
    { re: /^CREATE (TABLE|INDEX) IF NOT EXISTS "(user_sessions|IDX_user_sessions_expire)"/, why: 'migrateDb pre-creates the session table' },
    // The location backfill is detached from its init on purpose (a long
    // backfill must not hold the first write hostage) and marks itself done
    // in a column comment after the init returned.
    { re: /^COMMENT ON COLUMN integration_activity_log\.location_state/, why: 'done-marker of the detached location backfill' },
];

const { runMigrations } = require('../migrateDb');
const bootMigrations = require('../boot/bootMigrations');
/** A silent Console for the runner's progress lines. */
const quiet = /** @type {Console} */ (/** @type {unknown} */ ({ log() {}, info() {}, warn() {}, error() {} }));

/**
 * One db:migrate: the store phase watched by the gate (the boot ladder after
 * it has its own ledger and is not watched), and what the ledger did.
 * @param {{ force?: boolean }} [opts]
 */
async function migrate(opts = {}) {
    storeInit._resetAllForTests();
    /** @type {{ unit: string, sql: string }[]} */ const executed = [];
    let skipped = 0;
    const stop = ledger.observe((e) => {
        if (e.outcome === 'executed') executed.push({ unit: e.unit, sql: e.sql.replace(/\s+/g, ' ').trim().slice(0, 160) });
        else skipped++;
    });
    const realLoose = bootMigrations.runLooseMigrations;
    bootMigrations.runLooseMigrations = (o) => { watching = false; return realLoose(o); };
    bypassed.length = 0;
    watching = true;
    try {
        const report = await runMigrations({ log: quiet, ...opts });
        return { report, executed, skipped, bypassed: [...bypassed] };
    } finally {
        watching = false;
        stop();
        bootMigrations.runLooseMigrations = realLoose;
    }
}

/**
 * @param {string} sql @param {unknown[]} [params]
 * @returns {Promise<any[]>}
 */
const q = async (sql, params) => (await rawQuery(sql, params)).rows;
const tableNames = async () => (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r.table_name);
const storeUnits = async () => (await q(`SELECT name FROM schema_migrations WHERE name LIKE 'store:%' ORDER BY 1`)).map((r) => r.name);
/** @param {string} table @param {string} column */
const hasColumn = async (table, column) => (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).length === 1;

/** @param {{ failed: { name: string, error: string }[] }} report */
const failures = (report) => report.failed.map((f) => `${f.name}: ${f.error}`);

/** @type {string[]} */ let freshTables = [];
/** @type {string[]} */ let freshUnits = [];

test('fresh install: every table, a ledger unit per store, and no schema statement outside the ledger', async () => {
    const r = await migrate();
    assert.deepStrictEqual(failures(r.report), []);
    assert.deepStrictEqual(r.report.unverified, []);

    freshTables = await tableNames();
    for (const t of ['users', 'agents', 'automations', 'automation_runs', 'integration_activity_log',
        'compliance_signal_debounce', 'guardrail_events', 'integration_response_cache', 'knowledge_bases',
        'kb_sources', 'support_threads', 'support_inboxes', 'notifications', 'release_notes', 'studio_apps']) {
        assert.ok(freshTables.includes(t), `table missing after a fresh migrate: ${t}`);
    }
    freshUnits = await storeUnits();
    for (const u of ['store:AgentSchema', 'store:KbSources', 'store:UserStore', 'store:IntegrationActivityStore',
        'store:GuardrailEventStore', 'store:IntegrationCache', 'store:SupportStore', 'store:SupportInboxStore']) {
        assert.ok(freshUnits.includes(u), `no ledger unit for ${u}`);
    }
    assert.ok(freshUnits.length >= 90, `suspiciously few ledger units (${freshUnits.length})`);

    const stray = r.bypassed.filter((b) => !OUTSIDE_THE_LEDGER.some((a) => a.re.test(b.sql)));
    assert.deepStrictEqual(stray, [],
        'these schema statements reached the database outside the ledger. Send them from the\n' +
        "store's makeStoreInit init through db.exec / db.run / runDdl, or throughLedger(sql, ...)\n" +
        'for a raw pool query (stores/lib/ddlLedger.js):\n  ' +
        stray.map((b) => `${b.unit || '(no store init)'}: ${b.sql}`).join('\n  '));
    assert.ok(r.bypassed.some((b) => OUTSIDE_THE_LEDGER[0].re.test(b.sql)), 'the gate saw nothing at all; is it still watching?');
});

test('an unchanged install, once settled, sends no schema statement at all', async () => {
    // The second boot may still run a branch the first could not take (a
    // migration module that waits for a table a later store creates); the
    // third has nothing left.
    const second = await migrate();
    assert.deepStrictEqual(failures(second.report), []);
    const third = await migrate();
    assert.deepStrictEqual(failures(third.report), []);
    assert.deepStrictEqual(third.executed, [], 'a settled install re-sent schema statements');
    assert.ok(third.skipped > 900, `only ${third.skipped} statements were recognised as applied`);
    assert.deepStrictEqual(await tableNames(), freshTables);
    assert.deepStrictEqual(third.bypassed.filter((b) => !OUTSIDE_THE_LEDGER.some((a) => a.re.test(b.sql))), []);
});

async function seedRows() {
    await q(`INSERT INTO guardrail_events (violation_type) VALUES ('ledger-test')`);
    await q(`INSERT INTO integration_activity_log (tool_name) VALUES ('ledger-test')`);
    await q(`INSERT INTO compliance_signal_debounce (org_id, signal_key) VALUES ('ledger-test', 'k')`);
}
async function countRows() {
    const [g] = await q(`SELECT count(*)::int AS n FROM guardrail_events WHERE violation_type = 'ledger-test'`);
    const [i] = await q(`SELECT count(*)::int AS n FROM integration_activity_log WHERE tool_name = 'ledger-test'`);
    const [c] = await q(`SELECT count(*)::int AS n FROM compliance_signal_debounce WHERE org_id = 'ledger-test'`);
    return [g.n, i.n, c.n];
}

test('existing install, EMPTY ledger: upgrades without errors and without losing a row', async () => {
    await seedRows();
    const before = await countRows();
    await q(`DELETE FROM schema_migrations WHERE name LIKE 'store:%'`);
    const r = await migrate();
    assert.deepStrictEqual(failures(r.report), []);
    assert.ok(r.executed.length > 900, 'with no ledger entry every statement runs again');
    assert.deepStrictEqual(await countRows(), before);
    assert.deepStrictEqual(await tableNames(), freshTables);
    assert.deepStrictEqual(await storeUnits(), freshUnits);
});

test('existing install, STALE ledger keys: every statement runs again, nothing is lost', async () => {
    const before = await countRows();
    await q(`UPDATE schema_migrations SET ddl_statements = ARRAY['stale'], checksum = 'stale' WHERE name LIKE 'store:%'`);
    const r = await migrate();
    assert.deepStrictEqual(failures(r.report), []);
    assert.ok(r.executed.length > 900);
    assert.deepStrictEqual(await countRows(), before);
    const [row] = await q(`SELECT count(*)::int AS n FROM schema_migrations WHERE name LIKE 'store:%' AND checksum = 'stale'`);
    assert.strictEqual(row.n, 0, 'every unit carries a real checksum again');
});

test('existing install from BEFORE this ledger (no DDL columns): the migration rows stay, the stores join', async () => {
    const before = await countRows();
    await q(`DELETE FROM schema_migrations WHERE name LIKE 'store:%'`);
    await q(`ALTER TABLE schema_migrations DROP COLUMN ddl_statements, DROP COLUMN ddl_tables`);
    const ladder = (await q(`SELECT name, checksum FROM schema_migrations ORDER BY name`));
    assert.ok(ladder.length > 50, 'the boot ladder rows are there to keep');
    const r = await migrate();
    assert.deepStrictEqual(failures(r.report), []);
    assert.deepStrictEqual(await countRows(), before);
    assert.deepStrictEqual(await storeUnits(), freshUnits);
    const kept = await q(`SELECT name, checksum FROM schema_migrations WHERE name NOT LIKE 'store:%' ORDER BY name`);
    assert.deepStrictEqual(kept, ladder, 'not one boot-ladder row changed');
});

test('a statement NEW to an install runs there: the case the removed probes missed', async () => {
    // integrationCacheStore used to skip its whole schema once `payload_bytes`
    // existed. Simulate an install that has the table but never ran this
    // statement: drop the column and take the statement out of its entry.
    const stmt = 'ALTER TABLE integration_response_cache ADD COLUMN IF NOT EXISTS payload_bytes INTEGER';
    await q('ALTER TABLE integration_response_cache DROP COLUMN payload_bytes');
    await q(`UPDATE schema_migrations SET ddl_statements = array_remove(ddl_statements, $1) WHERE name = 'store:IntegrationCache'`,
        [ledger.statementKey(stmt)]);
    const r = await migrate();
    assert.deepStrictEqual(failures(r.report), []);
    assert.deepStrictEqual(r.executed.filter((e) => e.unit === 'store:IntegrationCache').map((e) => e.sql), [stmt],
        'exactly the new statement runs, the rest of that store is skipped');
    assert.ok(await hasColumn('integration_response_cache', 'payload_bytes'));
});

test('a table dropped behind the ledger comes back whole', async () => {
    await q('DROP TABLE guardrail_events');
    const r = await migrate();
    assert.deepStrictEqual(failures(r.report), []);
    assert.ok(await hasColumn('guardrail_events', 'is_dry_run'), 'its later columns came back too');
    assert.ok((await q(`SELECT to_regclass('idx_guardrail_org_ts_live') AS i`))[0].i, 'and its indexes');
    const units = new Set(r.executed.map((e) => e.unit));
    assert.deepStrictEqual([...units], ['store:GuardrailEventStore'], 'only the store that owns the table ran again');
});

test('--force runs every statement again', async () => {
    const r = await migrate({ force: true });
    assert.deepStrictEqual(failures(r.report), []);
    assert.ok(r.executed.length > 900);
    assert.strictEqual(r.skipped, 0);
});

test('boot and db:migrate run the same list through the same ledger', async () => {
    const { STORE_MODULES, collectStoreModules } = require('../storeModules');
    const migrateList = collectStoreModules(quiet).map((s) => s.name);
    assert.deepStrictEqual(migrateList.slice(0, STORE_MODULES.length), STORE_MODULES.map((s) => s.name),
        'db:migrate runs the boot list first, in the same order');

    // Boot: boot/storeSchemas.js over the same database, every init awaited.
    // The server starts them all at once; PGlite is ONE session, where one
    // init's transaction would swallow another's queries, so here each starts
    // when the previous one finished, still in the order boot gives them.
    storeInit._resetAllForTests();
    /** @type {Promise<unknown>[]} */ const running = [];
    /** @type {Promise<unknown>} */ let previous = Promise.resolve();
    let executed = 0;
    let skipped = 0;
    const stop = ledger.observe((e) => { if (e.outcome === 'executed') executed++; else skipped++; });
    try {
        const report = require('./storeSchemas').startStoreSchemas({
            log: quiet,
            load: (/** @type {string} */ file) => {
                const mod = require(path.join(SERVER, file));
                return {
                    initDB: () => {
                        const p = previous.then(() => (typeof mod.initDB === 'function' ? mod.initDB() : mod.ready));
                        previous = p.catch(() => undefined);
                        running.push(p);
                        return p;
                    },
                };
            },
        });
        assert.deepStrictEqual(report.failed, []);
        assert.deepStrictEqual(report.started, STORE_MODULES.map((s) => s.name));
        await Promise.all(running);
    } finally {
        stop();
    }
    assert.strictEqual(executed, 0, 'boot found every statement db:migrate applied');
    assert.ok(skipped > 900);
});

after(async () => {
    await pg.close();
});
