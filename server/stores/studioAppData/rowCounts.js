// @typecheck
/**
 * Per-table data versions (cache-invalidation tokens) and row counts of an
 * app: one FOR-UPDATE read-modify-write over each JSONB map, and the
 * authoritative recount against the per-app engine.
 */

const { getOne, withTransaction } = require('../../db');
const { rollback } = require('../../utils/txRollback');
const queryCompiler = require('../../appStudio/queryCompiler');
const { deps } = require('./cycleDeps');
const { parseJSON } = require('../lib/json');
const { initDB } = require('./schema');

/**
 * Bump a table's data version (a monotonically-increasing cache-invalidation
 * token). Read-modify-write of the whole data_versions JSONB under a row lock
 * so we don't depend on jsonb_set. Owner-scoped. Returns the new value, or null
 * when the app isn't owned / has no meta row yet.
 */
async function bumpDataVersion(appId, tableKey, ownerId) {
    await initDB();
    return withTransaction(async (client) => {
        const cur = await client.query(
            `SELECT data_versions FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2 FOR UPDATE`,
            [appId, ownerId]
        );
        if (cur.rows.length === 0) { return rollback(null); }
        const versions = parseJSON(cur.rows[0].data_versions, {});
        const next = (parseInt(versions[tableKey]) || 0) + 1;
        versions[tableKey] = next;
        await client.query(
            `UPDATE studio_app_data_meta SET data_versions = $1::jsonb, updated_at = NOW()
             WHERE app_id = $2 AND owner_user_id = $3`,
            [JSON.stringify(versions), appId, ownerId]
        );
        return next;
    });
}

/** row_counts map for the app (owner-scoped). {} when no meta row. */
async function getRowCounts(appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT row_counts FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2`,
        [appId, ownerId]
    );
    return r ? parseJSON(r.row_counts, {}) : {};
}

// Shared FOR-UPDATE read-modify-write over the row_counts JSONB (the ONE place
// that locks it — setRowCount / bumpRowCount / recountRows all go through here).
// `mutate` receives the parsed counts map and edits it in place. Returns the
// full map, or null when the app isn't owned / has no meta row yet.
async function withRowCounts(appId, ownerId, mutate) {
    await initDB();
    return withTransaction(async (client) => {
        const cur = await client.query(
            `SELECT row_counts FROM studio_app_data_meta WHERE app_id = $1 AND owner_user_id = $2 FOR UPDATE`,
            [appId, ownerId]
        );
        if (cur.rows.length === 0) { return rollback(null); }
        const counts = parseJSON(cur.rows[0].row_counts, {});
        mutate(counts);
        await client.query(
            `UPDATE studio_app_data_meta SET row_counts = $1::jsonb, updated_at = NOW()
             WHERE app_id = $2 AND owner_user_id = $3`,
            [JSON.stringify(counts), appId, ownerId]
        );
        return counts;
    });
}

/** Set one table's row count (owner-scoped). Returns the full map, or null. */
async function setRowCount(appId, tableKey, count, ownerId) {
    return withRowCounts(appId, ownerId, (counts) => {
        counts[tableKey] = Math.max(0, parseInt(count) || 0);
    });
}

/**
 * Delta-bump one table's cached row count (+1 create, -1 delete), clamped ≥ 0.
 * Same lock as setRowCount. Returns the full map, or null when not owned.
 */
async function bumpRowCount(appId, tableKey, delta, ownerId) {
    const d = parseInt(delta, 10) || 0;
    return withRowCounts(appId, ownerId, (counts) => {
        counts[tableKey] = Math.max(0, (parseInt(counts[tableKey], 10) || 0) + d);
    });
}

/**
 * Authoritative recount: COUNT(*) every given model table in the per-app
 * SQLite DB (owner-scoped) and REWRITE row_counts wholesale — dropped tables
 * fall out of the map. Called best-effort after a successful saveDataModel;
 * a table whose physical relation is missing counts as 0. Returns the new
 * map, or null when the app isn't owned.
 */
async function recountRows(appId, ownerId, tables) {
    await initDB();
    const fresh = {};
    for (const t of (Array.isArray(tables) ? tables : [])) {
        if (!t || typeof t.key !== 'string' || !t.key) continue;
        try {
            const { sql, params } = queryCompiler.compileAggregate(
                t, { aggregates: [{ fn: 'count', as: 'n' }] }, { where: '1=1', params: [] }
            );
            const { rows } = await deps.studioAppDbStore.query(ownerId, appId, sql, params);
            fresh[t.key] = rows && rows[0] ? Math.max(0, parseInt(rows[0].n, 10) || 0) : 0;
        } catch (_) {
            fresh[t.key] = 0; // physical table missing/mid-migration — authoritative 0
        }
    }
    return withRowCounts(appId, ownerId, (counts) => {
        for (const k of Object.keys(counts)) delete counts[k];
        Object.assign(counts, fresh);
    });
}

module.exports = { bumpDataVersion, getRowCounts, setRowCount, bumpRowCount, recountRows };
