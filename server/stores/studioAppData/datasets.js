// @typecheck
/**
 * Saved datasets (named query descriptors over a table) and their memoised
 * results, keyed by viewer scope, params hash and the table's data version.
 */

const crypto = require('crypto');
const { run, getOne, getAll, withTransaction } = require('../../db');
const { buildUpdate } = require('../lib/sqlBuilder');
const { initDB } = require('./schema');
const { mapDatasetRow, mapCacheRow } = require('./rowMappers');

// ── Datasets ────────────────────────────────────────────────────────

/**
 * @param appId
 * @param ownerId
 * @param {{ name?: string, tableId?: string, source?: string, descriptor?: any, cacheTtlSeconds?: number }} [opts]
 */
async function createDataset(appId, ownerId, { name, tableId, source, descriptor, cacheTtlSeconds } = {}) {
    await initDB();
    if (!appId || !ownerId) throw new Error('appId and ownerId required');
    const id = crypto.randomUUID();
    const row = await getOne(
        `INSERT INTO studio_app_datasets (id, app_id, owner_user_id, name, table_id, source, descriptor, cache_ttl_seconds)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`,
        [id, appId, ownerId, name || 'Untitled dataset', tableId || null,
         JSON.stringify(source || {}), JSON.stringify(descriptor || {}),
         Number.isFinite(cacheTtlSeconds) ? cacheTtlSeconds : 60]
    );
    return mapDatasetRow(row);
}

async function listDatasets(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM studio_app_datasets WHERE app_id = $1 AND owner_user_id = $2 ORDER BY updated_at DESC`,
        [appId, ownerId]
    );
    return rows.map(mapDatasetRow);
}

async function getDataset(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_datasets WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    return r ? mapDatasetRow(r) : null;
}

const DATASET_COLUMNS = {
    name: 'name',
    tableId: { col: 'table_id', transform: (v) => v || null },
    source: { col: 'source', cast: 'jsonb', transform: (v) => JSON.stringify(v || {}) },
    descriptor: { col: 'descriptor', cast: 'jsonb', transform: (v) => JSON.stringify(v || {}) },
    cacheTtlSeconds: { col: 'cache_ttl_seconds', transform: (v) => (Number.isFinite(v) ? v : 60) },
};

async function updateDataset(id, appId, ownerId, updates = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'studio_app_datasets',
        updates,
        columnMap: DATASET_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'app_id', value: appId }, { col: 'owner_user_id', value: ownerId }],
        returning: '*',
    });
    if (!built) return getDataset(id, appId, ownerId);
    const row = await getOne(built.sql, built.params);
    return row ? mapDatasetRow(row) : null;
}

async function deleteDataset(id, appId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT id FROM studio_app_datasets WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`,
        [id, appId, ownerId]
    );
    if (!r) return false;
    // Cache rows FK-cascade on dataset delete, but clear explicitly too so the
    // behaviour holds even where the FK isn't enforced.
    await run(`DELETE FROM studio_app_dataset_cache WHERE dataset_id = $1`, [id]);
    await run(`DELETE FROM studio_app_datasets WHERE id = $1 AND app_id = $2 AND owner_user_id = $3`, [id, appId, ownerId]);
    return true;
}

// ── Dataset cache ───────────────────────────────────────────────────
//
// Reached only through an owner-scoped dataset (getDataset gates ownership);
// the cache itself keys on the opaque dataset_id (a uuid) plus the viewer's
// scope key, the params hash, and the table's data_version. A hit is only
// returned when the data_version still matches AND the row hasn't expired.

/**
 * @param {string | number} dataVersion
 */
async function getCache(datasetId, viewerScopeKey, paramsHash, dataVersion) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_dataset_cache
         WHERE dataset_id = $1 AND viewer_scope_key = $2 AND params_hash = $3 AND data_version = $4`,
        [datasetId, viewerScopeKey, paramsHash, parseInt(dataVersion) || 0]
    );
    if (!r) return null;
    // Expiry filtered in JS so the query stays within the simple equality shape.
    if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) return null;
    return mapCacheRow(r);
}

/**
 * @param datasetId
 * @param {{ viewerScopeKey?: string, paramsHash?: string, dataVersion?: string|number, result?: any, rowCount?: number, ttlSeconds?: number }} [opts]
 */
async function putCache(datasetId, { viewerScopeKey, paramsHash, dataVersion, result, rowCount, ttlSeconds } = {}) {
    await initDB();
    const id = crypto.randomUUID();
    const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : 60;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    return withTransaction(async (client) => {
        // Replace any existing entry for this (dataset, viewer, params) tuple.
        await client.query(
            `DELETE FROM studio_app_dataset_cache
             WHERE dataset_id = $1 AND viewer_scope_key = $2 AND params_hash = $3`,
            [datasetId, viewerScopeKey, paramsHash]
        );
        await client.query(
            `INSERT INTO studio_app_dataset_cache
                (id, dataset_id, viewer_scope_key, params_hash, data_version, result, row_count, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
            [id, datasetId, viewerScopeKey, paramsHash, parseInt(dataVersion) || 0,
             JSON.stringify(result ?? {}), parseInt(rowCount) || 0, expiresAt]
        );
        return { ok: true, id, expiresAt };
    });
}

/** Drop all cached results for a dataset (e.g. after its descriptor changes). */
async function invalidateCache(datasetId) {
    await initDB();
    await run(`DELETE FROM studio_app_dataset_cache WHERE dataset_id = $1`, [datasetId]);
}

module.exports = {
    createDataset,
    listDatasets,
    getDataset,
    updateDataset,
    deleteDataset,
    getCache,
    putCache,
    invalidateCache,
};
