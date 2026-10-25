// @typecheck noImplicitAny
/**
 * runTables.js - the ledger for tables a RUN produced.
 *
 * Same two invariants as the generated-files ledger, because both are
 * security-shaped:
 *
 *   - A row is only read back through the run(s) or the automation the caller
 *     has already proven it may see. An id alone is not a capability.
 *   - `expires_at` is set at insert; reads are live-only (`expires_at > NOW()`).
 *     The reaper deletes the BLOB first and the ROW second.
 *
 * Tables are NOT generated files: this ledger is separate so no path that
 * serves generated files (form downloads, approval snapshots, the MCP file
 * list) can ever return row-level data.
 */

const core = require('./core');

/**
 * Every function takes an optional last argument `{ initDB, run, getOne, getAll }`
 * so a test can hand in its own database; production passes nothing.
 * @param {Partial<typeof core> | null} [deps]
 */
const dbOf = (deps) => deps || core;

/** @param {DbRow.AutomationRunTables | null} r */
function rowToRunTable(r) {
    if (!r) return null;
    return {
        id: r.id,
        runId: r.run_id ?? null,
        automationId: r.automation_id ?? null,
        stepId: r.step_id ?? null,
        storageKey: r.storage_key,
        name: r.name,
        columns: Array.isArray(r.columns) ? r.columns : [],
        rowCount: Number(r.row_count || 0),
        size: Number(r.size_bytes || 0),
        createdAt: r.created_at,
        expiresAt: r.expires_at,
    };
}

/**
 * @param {{ id: string, runId: string, automationId: string, stepId?: string | null, storageKey: string,
 * name: string, columns?: unknown[], rowCount?: number, size?: number, ttlMs: number }} table
 * @param {Partial<typeof core> | null} [deps]
 */
async function recordRunTable({ id, runId, automationId, stepId = null, storageKey, name, columns, rowCount = 0, size = 0, ttlMs }, deps) {
    const { initDB, run } = dbOf(deps);
    await initDB();
    await run(
        `INSERT INTO automation_run_tables
             (id, run_id, automation_id, step_id, storage_key, name, columns, row_count, size_bytes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW() + ($10::bigint * INTERVAL '1 millisecond'))`,
        [id, runId, automationId, stepId, storageKey, name, JSON.stringify(columns || []), rowCount, size, ttlMs],
    );
    return { id, runId, automationId, stepId, storageKey, name, columns: columns || [], rowCount, size };
}

/**
 * One live table, but only if it belongs to one of the runs the caller already has access to.
 * @param {string} id
 * @param {string[]} runIds
 * @param {Partial<typeof core> | null} [deps]
 */
async function getRunTableForRuns(id, runIds, deps) {
    if (!id || !Array.isArray(runIds) || runIds.length === 0) return null;
    const { initDB, getOne } = dbOf(deps);
    await initDB();
    return rowToRunTable(await getOne(
        `SELECT * FROM automation_run_tables
          WHERE id = $1 AND run_id = ANY($2::text[]) AND expires_at > NOW()`,
        [id, runIds],
    ));
}

/**
 * One live table of this automation. The caller still has to prove the right to
 * read the producing run (the table store does); this only fences the id to one
 * automation.
 * @param {string} id
 * @param {string} automationId
 * @param {Partial<typeof core> | null} [deps]
 */
async function getRunTableForAutomation(id, automationId, deps) {
    if (!id || !automationId) return null;
    const { initDB, getOne } = dbOf(deps);
    await initDB();
    return rowToRunTable(await getOne(
        `SELECT * FROM automation_run_tables
          WHERE id = $1 AND automation_id = $2 AND expires_at > NOW()`,
        [id, automationId],
    ));
}

/**
 * The ids of the live tables the given runs wrote (a journey: the run and the legs around its pauses).
 * @param {string[]} runIds
 * @param {Partial<typeof core> | null} [deps]
 */
async function listLiveRunTableIdsForRuns(runIds, deps) {
    if (!Array.isArray(runIds) || runIds.length === 0) return [];
    const { initDB, getAll } = dbOf(deps);
    await initDB();
    const rows = await getAll(
        `SELECT id FROM automation_run_tables WHERE run_id = ANY($1::text[]) AND expires_at > NOW()`,
        [runIds],
    );
    return rows.map(r => r.id);
}

/**
 * How many live tables a run already wrote (the per-run cap).
 * @param {string} runId
 * @param {Partial<typeof core> | null} [deps]
 */
async function countRunTablesForRun(runId, deps) {
    if (!runId) return 0;
    const { initDB, getOne } = dbOf(deps);
    await initDB();
    const r = await getOne(
        `SELECT COUNT(*)::int AS n FROM automation_run_tables WHERE run_id = $1 AND expires_at > NOW()`,
        [runId],
    );
    return Number(r?.n || 0);
}

/**
 * Rows to reap: expired ones, plus orphans whose run or automation is gone (the
 * foreign keys set the link to NULL on delete, so run retention and the trash
 * purge leave the row behind with its blob). The caller deletes the blobs, then
 * the rows.
 * @param {number} [limit]
 * @param {Partial<typeof core> | null} [deps]
 */
async function listExpiredRunTables(limit = 200, deps) {
    const { initDB, getAll } = dbOf(deps);
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_run_tables
          WHERE expires_at < NOW() OR run_id IS NULL OR automation_id IS NULL
          ORDER BY expires_at LIMIT $1`,
        [limit],
    );
    return rows.map(rowToRunTable);
}

/**
 * @param {string[]} ids
 * @param {Partial<typeof core> | null} [deps]
 */
async function deleteRunTables(ids, deps) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const { initDB, run } = dbOf(deps);
    await initDB();
    const { rowCount } = await run(`DELETE FROM automation_run_tables WHERE id = ANY($1::text[])`, [ids]);
    return rowCount;
}

/**
 * Push expiry OUT to at least `until`, never in. A null `until` extends nothing.
 * @param {string[]} ids
 * @param {Date | string} until
 * @param {Partial<typeof core> | null} [deps]
 */
async function extendRunTableExpiry(ids, until, deps) {
    if (!Array.isArray(ids) || ids.length === 0 || !until) return 0;
    const { initDB, run } = dbOf(deps);
    await initDB();
    const { rowCount } = await run(
        `UPDATE automation_run_tables SET expires_at = GREATEST(expires_at, $2) WHERE id = ANY($1::text[])`,
        [ids, until],
    );
    return rowCount;
}

module.exports = {
    recordRunTable,
    getRunTableForRuns,
    getRunTableForAutomation,
    countRunTablesForRun,
    listLiveRunTableIdsForRuns,
    listExpiredRunTables,
    deleteRunTables,
    extendRunTableExpiry,
};
