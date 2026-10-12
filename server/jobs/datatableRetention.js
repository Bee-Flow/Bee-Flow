/**
 * Datatable row retention — the sweep that makes "deleted after N days" true.
 *
 * A datatable is where an automation parks the personal data it collects: form
 * answers, e-mail addresses, order lines, whatever the org's own process
 * produces. `datatables.retention_days` and `retention_field` have existed
 * since the feature shipped, `publicTable` already sent the window to the
 * client, and `idx_datatables_retention` is a partial index built for a sweeper
 * that did not exist. Nothing ever deleted a row. This is that sweeper.
 *
 * ── WHY IT IS NOT ON processRunRetention'S TICK ─────────────────────
 * scheduler/ticks.js registers processRunRetention as
 * `moduleGatedTick('automation', …)`, which re-reads the runtime module row on
 * every invocation. Parking row expiry there means that the moment an org's
 * Automations module is switched off — or its licence lapses — deletion stops
 * while the personal data stays and the UI keeps promising "deleted after N
 * days". A retention obligation must never be gated on a billable feature, so
 * this has its own tick, its own advisory lock, and no module gate.
 *
 * ── FOUR GUARDS, BECAUSE THIS DELETES CUSTOMER DATA ON A TIMER ──────
 *   1. Opt-in twice. A table is only ever swept when its owner set a window AND
 *      named the date column — the PATCH route refuses one without the other.
 *   2. The compiler's NOT NULL guard. compileSelectOlderThan will not name a
 *      row whose date column is empty: no date means no age, and an undated row
 *      is data nobody dated, not data that expired.
 *   3. A per-pass cap. A misconfiguration becomes a partial delete somebody
 *      notices, not a table emptied between two heartbeats.
 *   4. DATATABLE_RETENTION_DISABLED. A permanent operator brake, available
 *      during the incident it exists for.
 *
 * ── AND ONE THING IT DOES NOT REACH ─────────────────────────────────
 * An automation's `find_rows` step copies what it read into
 * `automation_run_steps.output`, which is reaped only by age under
 * AUTOMATION_RUN_RETENTION_DAYS (default 90). Deleting a row here does NOT
 * remove those copies. The control in the Studio says so; making an Art. 17
 * erasure request reach them is a separate piece of work on the DSR fulfilment
 * path, not something a time-based sweep can solve.
 */

'use strict';

const datatableStore = require('../stores/datatableStore');
const datatableDbStore = require('../stores/datatableDbStore');
const queryCompiler = require('../core/dataEngine/queryCompiler');
const accessFilter = require('../core/dataEngine/accessFilter');
const { retentionFieldError } = require('../core/dataEngine/dataModel/datatableFields');
const { isSourceManagedKind } = require('../core/dataEngine/dataModel/managedTables');
const { envFlagOn } = require('../core/automationRunner/integrationCachePolicy');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

// Rows are always in Postgres — the App Studio engine flag is a process global
// that may say 'sqlite', and compiling under it would emit SQL for the wrong
// database. Stated at every compile, as everywhere else on this path.
const PG = { dialect: 'pg' };

// The most rows one table may lose in one pass. Not a performance number: it is
// what turns a misconfigured window into a partial delete an owner notices
// instead of a table that was full at 02:00 and empty at 03:00.
const MAX_ROWS_PER_TABLE_PER_PASS = 5000;

// Statements per batch() call. pgAppEngine's MAX_BATCH_STATEMENTS is 500, and
// each chunk is one transaction — so a failure mid-pass leaves whole chunks
// applied and the rest untouched, never half a statement.
const DELETE_CHUNK = 500;

/**
 * Retention is the TABLE's own rule, so it runs at owner grade.
 *
 * Not a convenience: a viewer-grade filter would scope the sweep to rows
 * created by whoever the "viewer" happened to be, so a table whose rows were
 * written by four different automations would age out a quarter of itself and
 * report success. There is no viewer here — the org set a policy about the
 * whole table.
 */
function ownerFilter(meta) {
    return accessFilter.compileAccessFilter(meta, 'owner', { id: null }, 'delete', PG);
}

/** Is the whole sweep switched off for this process? */
function killSwitchOn() {
    // envFlagOn, not bare truthiness: `DATATABLE_RETENTION_DISABLED=0` is a
    // non-empty string, so `!process.env.X` would switch deletion OFF at the
    // exact moment an operator wrote the word they think means "leave it on" —
    // and the only symptom is personal data quietly outliving its window.
    return envFlagOn('DATATABLE_RETENTION_DISABLED');
}

/**
 * Sweep ONE table. Never throws: a table with a dropped date column, a schema
 * the engine cannot reach or a compile failure must not stop the pass for every
 * other org in the deployment.
 *
 * @returns {Promise<{deleted:number, skipped?:string}>}
 */
async function sweepTable(table) {
    // A mirror of an external source (core/dataEngine/sources) never has a
    // window — PATCH refuses one — but the row is checked here too: deleting
    // its rows would only remove a copy the next refresh puts straight back,
    // while churning every knowledge base and page that reads it. The rows
    // age out where they live, at the source.
    if (isSourceManagedKind(table.managedKind)) return { deleted: 0, skipped: 'mirror' };
    const scope = table.scope;
    const scopeKey = datatableDbStore.scopeKey(scope);
    const meta = await datatableStore.getTableMeta(scope, table.id);
    if (!meta) return { deleted: 0, skipped: 'no_columns' };

    // The column the owner chose may have been renamed or dropped since — a
    // schema save is a different route with a different guard. Falling back to
    // `created_at` here would delete on a rule nobody picked, which is the exact
    // failure the PATCH route refuses to allow at the other end. Say it once,
    // loudly, and leave the rows alone.
    const fieldErr = retentionFieldError(meta, table.retentionField);
    if (fieldErr) {
        log.warn(`[datatableRetention] SKIPPING ${table.id} ("${table.name}"): ${fieldErr} — its rows are NOT being aged out`);
        return { deleted: 0, skipped: 'bad_field' };
    }

    const cutoffIso = new Date(Date.now() - table.retentionDays * 24 * 60 * 60_000).toISOString();
    const filter = ownerFilter(meta);
    let deleted = 0;

    while (deleted < MAX_ROWS_PER_TABLE_PER_PASS) {
        const want = Math.min(queryCompiler.MAX_RESULT_ROWS, MAX_ROWS_PER_TABLE_PER_PASS - deleted);
        const probe = queryCompiler.compileSelectOlderThan(meta, filter, {
            field: table.retentionField, cutoffIso, limit: want, ...PG,
        });
        const found = await datatableDbStore.query(scopeKey, scopeKey, probe.sql, probe.params);
        const ids = (found.rows || []).map(r => r && r.id).filter(Boolean);
        if (!ids.length) break;

        let removed = 0;
        for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
            const chunk = ids.slice(i, i + DELETE_CHUNK).map(id => (
                // Through the compiler and with the access filter still ANDed
                // in, so a row that left scope between the SELECT and the
                // DELETE is not removed on the strength of a stale read.
                queryCompiler.compileDelete(meta, id, filter, PG)
            ));
            const results = await datatableDbStore.batch(scopeKey, scopeKey, chunk);
            for (const r of results || []) removed += Number(r?.changes) || 0;
        }
        deleted += removed;
        // Found rows but removed none: something is refusing the delete (a
        // trigger, a narrowed filter). Looping would re-read the same ids
        // forever, so stop and let the warning carry the pass.
        if (removed === 0) {
            log.warn(`[datatableRetention] ${table.id}: ${ids.length} expired row(s) matched but none were deleted — stopping this table`);
            break;
        }
    }

    if (deleted > 0) {
        // The REAL count, and then the truth from Postgres. row_count is
        // maintained by arithmetic so a row write takes no lock, and arithmetic
        // drifts; the sweep is the one moment the true COUNT(*) is cheap.
        await datatableStore.bumpAfterWrite(table.id, scope, -deleted);
        await reconcileRowCount(table, meta, scopeKey);
    }
    await datatableStore.stampRetentionSweep(table.id, scope);
    return { deleted };
}

/**
 * Re-sync `row_count` with COUNT(*), and refresh the scope's `size_bytes` while
 * the schema is warm.
 *
 * Best-effort on purpose: this is bookkeeping that follows a delete which has
 * already committed, and failing it must not make the caller think the rows are
 * still there.
 */
async function reconcileRowCount(table, meta, scopeKey) {
    try {
        const filter = ownerFilter(meta);
        const { sql, params } = queryCompiler.compileAggregate(meta, {
            aggregates: [{ fn: 'count', as: 'n' }], ...PG,
        }, filter);
        const out = await datatableDbStore.query(scopeKey, scopeKey, sql, params);
        const n = Number(out.rows?.[0]?.n);
        if (Number.isFinite(n)) await datatableStore.setRowCount(table.id, table.scope, n);
    } catch (e) {
        log.warn(`[datatableRetention] could not re-count ${table.id}: ${e.message}`);
    }
    try {
        // Mirrored into datatable_models by the engine itself (mirrorScopeSize).
        await datatableDbStore.sizeBytes(scopeKey, scopeKey);
    } catch (_) { /* the quota reader tolerates a stale size */ }
}

/**
 * One pass over every table in the deployment that has a retention window.
 *
 * @returns {Promise<{deleted:number, tables:number, skipped:number, disabled?:boolean}>}
 */
async function datatableRetentionPass() {
    if (killSwitchOn()) {
        log.warn('[datatableRetention] DATATABLE_RETENTION_DISABLED is set — no rows will be aged out');
        return { deleted: 0, tables: 0, skipped: 0, disabled: true, ts: new Date().toISOString() };
    }
    const t0 = Date.now();
    let ok = true;
    let deleted = 0;
    let skipped = 0;
    let tables = 0;
    try {
        const withWindow = await datatableStore.listDatatablesWithRetention();
        tables = withWindow.length;
        for (const table of withWindow) {
            try {
                const out = await sweepTable(table);
                deleted += out.deleted;
                if (out.skipped) skipped += 1;
            } catch (e) {
                // One table's failure is not the pass's failure — the next org
                // in the list has its own retention obligation.
                skipped += 1;
                log.error(`[datatableRetention] ${table.id} failed: ${e.message}`);
            }
        }
    } catch (e) {
        ok = false;
        log.error('[datatableRetention] pass error:', e.message);
    }
    recordJobRun({ job: 'datatable_retention', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
    if (deleted) log.info(`[datatableRetention] deleted ${deleted} row(s) across ${tables} table(s)`);
    return { deleted, tables, skipped, ts: new Date().toISOString() };
}

module.exports = {
    datatableRetentionPass,
    killSwitchOn,
    MAX_ROWS_PER_TABLE_PER_PASS,
    DELETE_CHUNK,
    // test-only
    _sweepTable: sweepTable,
};
