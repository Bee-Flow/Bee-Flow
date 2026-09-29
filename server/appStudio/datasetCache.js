/**
 * App Studio v2 — SAVED-DATASET RUNNER + scope-partitioned result cache.
 *
 * A "dataset" is a named, reusable aggregate query over one table (see
 * studioAppDataStore.studio_app_datasets). This module is the read path that
 * turns a dataset (or an inline aggregate descriptor) into rows, memoising the
 * result in studio_app_dataset_cache — but ONLY within the viewer's access
 * scope.
 *
 * ── THE SECURITY INVARIANT (why the cache key is what it is) ─────────
 * The cache is partitioned by `viewer_scope_key` = a stable hash of the
 * COMPILED ACCESS IDENTITY: the viewer's role PLUS the exact access predicate
 * the RLS gateway produces ({where, params}). Two viewers share a cache
 * partition ONLY when their compiled access filter is byte-identical:
 *
 *   • a manager (read: all → WHERE 1=1, [])            → key K_manager
 *   • member Alice (read: own → created_by = ?, [A])   → key K_A
 *   • member Bob   (read: own → created_by = ?, [B])   → key K_B
 *
 * K_manager ≠ K_A ≠ K_B, so a manager's aggregated numbers can NEVER be served
 * to a member, and one member's cached rows can NEVER be served to another.
 * This is an ACCESS control, not merely a performance key — the row filter's
 * bound params (viewer.<attr>) are folded into the identity too, so a
 * per-region row filter partitions per region automatically.
 *
 * ── FRESHNESS ───────────────────────────────────────────────────────
 * A hit additionally requires the table's CURRENT data_version (bumped on every
 * write via studioAppDataStore.bumpDataVersion) and a non-expired TTL row. Any
 * write to the table therefore invalidates every viewer's cache for it; `?refresh`
 * forces a recompute regardless. The access filter is ALWAYS compiled and passed
 * to queryCompiler.compileAggregate on a miss — there is no unscoped path.
 *
 * The compiler (queryCompiler.js) remains the ONLY producer of SQL and the RLS
 * gateway (rlsGateway.js) the ONLY producer of the access filter; this module
 * imports both and never builds SQL or predicates itself.
 */

'use strict';

const crypto = require('crypto');
const studioAppDataStore = require('../stores/studioAppDataStore');
const studioAppDbStore = require('../stores/studioAppDbStore');
const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');

const DEFAULT_TTL_SECONDS = 60;

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted recursively so two structurally-equal
 * descriptors/identities always hash to the same string regardless of key
 * insertion order. Arrays keep their order (filter order is significant).
 */
function stableStringify(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * The cache partition key = a hash of the COMPILED ACCESS IDENTITY. Derived
 * from the viewer's role plus the exact access predicate ({where, params})
 * rlsGateway.compileAccessFilter produced for this table+action. Identical
 * compiled access ⇒ same key (safe to share); any difference ⇒ different key
 * (never shared). This is the security control described in the file header.
 */
function computeViewerScopeKey(role, accessFilter) {
    const af = accessFilter && typeof accessFilter === 'object' ? accessFilter : {};
    const identity = {
        role: role || null,
        where: typeof af.where === 'string' ? af.where : '',
        params: Array.isArray(af.params) ? af.params : [],
    };
    return sha256('viewerscope:v1:' + stableStringify(identity));
}

/** Fingerprint of the query descriptor — only the fields that shape the SQL. */
function computeParamsHash(tableKey, descriptor) {
    const d = descriptor && typeof descriptor === 'object' ? descriptor : {};
    const norm = {
        table: tableKey || null,
        filters: d.filters ?? null,
        groupBy: d.groupBy ?? null,
        aggregates: d.aggregates ?? null,
        sort: d.sort ?? null,
        limit: d.limit ?? null,
    };
    return sha256('params:v1:' + stableStringify(norm));
}

function resolveTable(model, tableRef) {
    const tables = model && Array.isArray(model.tables) ? model.tables : [];
    return tables.find((t) => t && (t.id === tableRef || t.key === tableRef)) || null;
}

/** The table's current cache-invalidation token (0 when no meta row yet). */
async function currentDataVersion(app, tableKey) {
    try {
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const versions = meta && meta.dataVersions && typeof meta.dataVersions === 'object' ? meta.dataVersions : {};
        return parseInt(versions[tableKey], 10) || 0;
    } catch {
        return 0;
    }
}

/**
 * Run a saved dataset (or an inline aggregate descriptor), cache-aware.
 *
 *   runDataset(app, model, datasetOrDescriptor, viewer, { refresh }) →
 *     { columns, rows, truncated, cached }
 *
 * `datasetOrDescriptor` is EITHER a saved dataset row
 *   { id, tableId, descriptor, cacheTtlSeconds }  — cache-persisted
 * OR an inline shape
 *   { tableId | tableKey, descriptor | aggregate }  — run live (no id → the
 *   dataset_cache FK can't hold it, so inline queries are never persisted).
 *
 * `viewer` is the server-derived viewer object ({ id, role?, organizationId?,
 * userGroups? }). When `viewer.role` is provided the caller has already resolved
 * it (the route path); otherwise it's resolved here via rlsGateway. The same
 * `viewer` object is handed to compileAccessFilter so row filters reading
 * viewer.<attr> bind correctly.
 */
async function runDataset(app, model, datasetOrDescriptor, viewer, { refresh = false } = {}) {
    if (!app || !app.id) throw new rlsGateway.AccessError('app is required', 400);
    if (!model || !Array.isArray(model.tables)) throw new rlsGateway.AccessError('data model is required', 400);

    const dod = datasetOrDescriptor && typeof datasetOrDescriptor === 'object' ? datasetOrDescriptor : {};
    const datasetId = typeof dod.id === 'string' && dod.id ? dod.id : null;
    const descriptor = (dod.descriptor && typeof dod.descriptor === 'object') ? dod.descriptor
        : (dod.aggregate && typeof dod.aggregate === 'object') ? dod.aggregate
            : dod;
    const tableRef = dod.tableId || dod.tableKey || descriptor.tableId || descriptor.tableKey || null;

    const table = resolveTable(model, tableRef);
    if (!table) throw new rlsGateway.AccessError('Table not found', 404);

    const v = viewer && typeof viewer === 'object' ? viewer : {};
    // Resolve the viewer's role unless the caller already did (route path).
    let role = Object.prototype.hasOwnProperty.call(v, 'role') ? v.role : undefined;
    if (role === undefined) {
        role = await rlsGateway.resolveViewerRole(app, v.id, model, { userGroups: Array.isArray(v.userGroups) ? v.userGroups : [] });
    }
    if (!rlsGateway.canRead(table, role)) throw new rlsGateway.AccessError('Forbidden', 403);

    // The access filter — ALWAYS present, ALWAYS AND-ed into the query. Compiled
    // here from the (role, viewer) so a member's chart folds only their rows.
    const accessFilter = rlsGateway.compileAccessFilter(table, role, v, 'read');

    const viewerScopeKey = computeViewerScopeKey(role, accessFilter);
    const paramsHash = computeParamsHash(table.key, descriptor);
    const dataVersion = await currentDataVersion(app, table.key);
    const ttlSeconds = Number.isFinite(dod.cacheTtlSeconds) ? dod.cacheTtlSeconds : DEFAULT_TTL_SECONDS;

    // Only SAVED datasets are cache-persisted (studio_app_dataset_cache FKs the
    // dataset id). Inline descriptors always run live.
    const cacheable = !!datasetId;

    if (cacheable && !refresh) {
        const hit = await studioAppDataStore.getCache(datasetId, viewerScopeKey, paramsHash, dataVersion);
        if (hit && hit.result && typeof hit.result === 'object') {
            const r = hit.result;
            return {
                columns: Array.isArray(r.columns) ? r.columns : [],
                rows: Array.isArray(r.rows) ? r.rows : [],
                truncated: !!r.truncated,
                cached: true,
            };
        }
    }

    // Miss / forced refresh / inline → compile (scoped) and run live.
    const { sql, params } = queryCompiler.compileAggregate(table, {
        filters: descriptor.filters,
        groupBy: descriptor.groupBy,
        aggregates: descriptor.aggregates,
        sort: descriptor.sort,
        limit: descriptor.limit,
    }, accessFilter);

    const out = await studioAppDbStore.query(app.userId, app.id, sql, params);
    const result = {
        columns: Array.isArray(out.columns) ? out.columns : [],
        rows: Array.isArray(out.rows) ? out.rows : [],
        truncated: !!out.truncated,
    };

    if (cacheable) {
        try {
            await studioAppDataStore.putCache(datasetId, {
                viewerScopeKey,
                paramsHash,
                dataVersion,
                result,
                rowCount: result.rows.length,
                ttlSeconds,
            });
        } catch {
            /* cache write is advisory — a failed memoise must never fail the read */
        }
    }

    return { ...result, cached: false };
}

module.exports = {
    runDataset,
    computeViewerScopeKey,
    computeParamsHash,
    DEFAULT_TTL_SECONDS,
    // Test-only internals
    _stableStringify: stableStringify,
    _resolveTable: resolveTable,
};
