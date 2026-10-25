// @typecheck
/**
 * Postgres app-data engine — the 'pg' implementation of the studioAppDbStore
 * facade contract (see that file's ENGINE FACADE CONTRACT block). Where the
 * sqlite blob engine materialises one data.db blob per app, this engine keeps
 * each app's tables in a dedicated Postgres SCHEMA (`app_<appId>`) inside the
 * EXISTING beeflow_core database — no blob, no flush pipeline, no replica
 * clobbering: Postgres itself is the multi-replica story.
 *
 *   query/exec/batch    one transaction each:
 *                       BEGIN → ownership+engine interlock → SET LOCAL
 *                       search_path = "app_<id>", pg_temp → statements → COMMIT
 *   applyMigration      same, with a per-statement SAVEPOINT so a replayed
 *                       plan skips already-applied DDL (SQLSTATE 42701/42P07)
 *                       instead of aborting — the pg analog of
 *                       dataModel.applyPlanTolerantly.
 *   schema stamp        a per-schema `_meta(key,value)` table, key
 *                       'schema_stamp' — the pg analog of PRAGMA user_version.
 *
 * ── TRUST BOUNDARY / SECURITY ───────────────────────────────────────
 * Identical to the sqlite engine: methods are MODULE-INTERNAL, only ever called
 * with compiler-generated SQL, never with client SQL. `ownerId` is a trust
 * boundary — every call re-verifies it against studio_apps.user_id (60 s
 * in-process cache) INSIDE the transaction, and refuses with the same message
 * the sqlite engine uses. The ENGINE INTERLOCK is checked in the same read:
 * studio_apps.engine must be 'pg' or the call fails with
 * { code: 'engine_mismatch', status: 503 } — a stale replica still configured
 * for pg can never touch an app the fleet has migrated back to sqlite (and
 * vice versa, enforced by the sqlite side in B3).
 *
 * All statements run with search_path pinned to the app's schema (+ pg_temp),
 * so compiler-emitted unqualified identifiers can only ever resolve inside
 * that app's namespace. The ownership SELECT runs BEFORE the SET LOCAL, while
 * the connection still resolves studio_apps normally.
 *
 * ── PLACEHOLDERS ────────────────────────────────────────────────────
 * The query compiler always emits `?` placeholders (sqlite style). This engine
 * converts them ONCE via toDollarParams(sql, expectedCount), which is
 * quote-aware and ASSERTS the `?` count equals params.length — a mismatch is a
 * compiler bug and must be loud, not a silently shifted bind.
 *
 * ── WIRE FORMAT (kept stable with the sqlite engine, cheaply) ───────
 * node-postgres would hand back BIGINT/NUMERIC as strings and DATE/TIMESTAMPTZ
 * as JS Dates (DATE at driver-local midnight — a JSON day-shift bug waiting
 * west of UTC). normalizeRows() converts, per result-field type id:
 *   int8/numeric → Number  ·  date → 'YYYY-MM-DD'  ·  timestamp(tz) → ISO
 * so rows serialize exactly like the sqlite engine's. BOOLEAN values stay
 * true/false (sqlite returns 0/1) — every audited consumer (FE boolValue(),
 * connectorSync truthiness) already accepts both; deliberately NOT coerced.
 *
 * ── DEPENDENCY INJECTION (load-bearing, not style) ──────────────────
 * `runQuery` and `getClient` are injected by the wrapper (studioAppDbStore)
 * instead of required here, exactly like the sqlite engine's `storage`/
 * `runQuery`: the wrapper's DB-free tests stub '../db' AS WRITTEN IN THE
 * WRAPPER, and the pg tests back this engine with pglite through the same
 * seam. Do NOT "simplify" this into a direct require('../../db').
 */

'use strict';
const log = require('../../telemetry/log');
const {
    SIZE_TTL_MS, toDollarParams, normalizeRows, dateOnlyString, mapPgError, normalizeParams,
} = require('./pgAppEngineHelpers');
const { makeTx, makeStatements, makeMigration } = require('./pgAppEnginePartsTx');
const { bestEffort } = require('../../utils/bestEffort');

/** schema inspection + the cached on-disk size. */
function makeInspect({ schemaFor, runQuery, logPrefix, sizeCache, mirrorSizeFn, withAppTx }) {
    /** Schema inspection → { tables: [{ name, columns: [...] }] } (sans _meta). */
    async function schema(ownerId, appId) {
        const schemaName = String(schemaFor(appId));
        return withAppTx(ownerId, appId, { readOnly: true }, async (client) => {
            const cols = await client.query(
                `SELECT table_name, column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name <> '_meta'
                 ORDER BY table_name, ordinal_position`,
                [schemaName],
            );
            const pks = await client.query(
                `SELECT kcu.table_name, kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
                 WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
                [schemaName],
            );
            const pkSet = new Set((pks.rows || []).map(r => `${r.table_name}\u0000${r.column_name}`));
            const byTable = new Map();
            for (const r of (cols.rows || [])) {
                if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
                byTable.get(r.table_name).push({
                    name: r.column_name,
                    type: String(r.data_type || '').toUpperCase(),
                    notNull: r.is_nullable === 'NO',
                    defaultValue: r.column_default ?? null,
                    primaryKey: pkSet.has(`${r.table_name}\u0000${r.column_name}`),
                });
            }
            return { tables: [...byTable.entries()].map(([name, columns]) => ({ name, columns })) };
        });
    }

    /**
     * Total on-disk bytes of the app schema's relations (30 s cache). The
     * authoritative number for quota checks; also mirrored fire-and-forget
     * into studio_apps.db_size so app-list reads stay join-free.
     */
    async function sizeBytes(ownerId, appId) {
        const cached = sizeCache.get(appId);
        if (cached && (Date.now() - cached.ts) < SIZE_TTL_MS) return cached.bytes;
        const schemaName = String(schemaFor(appId));
        const bytes = await withAppTx(ownerId, appId, { readOnly: true }, async (client) => {
            const res = await client.query(
                `SELECT COALESCE(SUM(pg_total_relation_size(
                     (quote_ident(schemaname) || '.' || quote_ident(tablename))::regclass
                 )), 0) AS bytes
                 FROM pg_tables WHERE schemaname = $1`,
                [schemaName],
            );
            const n = Number(res.rows?.[0]?.bytes);
            return Number.isFinite(n) ? n : 0;
        });
        sizeCache.set(appId, { bytes, ts: Date.now() });
        Promise.resolve(
            mirrorSizeFn
                ? mirrorSizeFn(appId, ownerId, bytes)
                : runQuery(
                    'UPDATE studio_apps SET db_size = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
                    [bytes, appId, ownerId],
                ),
        ).catch(err => log.warn(`[${logPrefix}] db_size mirror failed for ${appId}:`, err.message));
        return bytes;
    }

    return { schema, sizeBytes };
}

/** reset / flush / invalidate / closeAll: lifecycle and cache control. */
function makeLifecycle({ getClient, schemaIdent, assertOwnership, clearMetaFn, sizeCache, ownershipCache }) {
    /** Drop the app schema entirely and zero the studio_apps size metadata. */
    async function reset(ownerId, appId) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await assertOwnership(client, ownerId, appId);
            await client.query(`DROP SCHEMA IF EXISTS ${schemaIdent(appId)} CASCADE`);
            if (clearMetaFn) {
                await clearMetaFn(client, appId, ownerId);
            } else {
                await client.query(
                    `UPDATE studio_apps SET db_sha256 = '', db_size = 0, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
                    [appId, ownerId],
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) { bestEffort('stores/lib/pgAppEngine:reset', _); /* connection already broken, the original error is rethrown */ }
            throw mapPgError(err);
        } finally {
            client.release();
        }
        sizeCache.delete(appId);
    }

    // Postgres commits ARE durability — nothing to flush. Kept so the facade
    // surface is identical across engines.
    async function flush(_ownerId, _appId) { /* no-op */ }

    /** Drop cached facts for one app (ownership + size). */
    async function invalidate(appId) {
        ownershipCache.delete(appId);
        sizeCache.delete(appId);
    }

    /** Clear every cache. No handles to close — the pool belongs to db.js. */
    async function closeAll() {
        ownershipCache.clear();
        sizeCache.clear();
    }

    return { reset, flush, invalidate, closeAll };
}

/**
 * Build one engine instance.
 *
 * @param {object} config
 * @param {Function} config.runQuery    async (sql, params) => result — pooled,
 *                                      OUTSIDE any app transaction (metadata
 *                                      mirrors like db_size). Wrapper passes db.run.
 * @param {Function} config.getClient   async () => pg client with query() +
 *                                      release() — one checkout per app call.
 * @param {string}   config.logPrefix   Console tag, e.g. 'StudioAppDB'.
 * @param {string}   config.entityLabel Error noun, e.g. 'Studio App DB'.
 * @param {Function} config.schemaFor   (appId) => Postgres schema name
 *                                      ('app_' + appId, dashes kept — always
 *                                      quoted, and at 4+36 chars safely under
 *                                      the 63-char identifier limit).
 *
 * The three below decouple the engine from `studio_apps`. They default to the
 * App Studio behaviour, so the existing wiring and its tests construct the
 * engine exactly as before; a second consumer (automation datatables) passes
 * its own. schemaFor was already injected, but these three SQL statements were
 * not, which is what made the engine App-Studio-only in practice.
 *
 * @param {Function} [config.assertAccess]  async (client, ownerId, entityId) — runs
 *                                      INSIDE the transaction, BEFORE search_path
 *                                      is narrowed, so a metadata table in the
 *                                      public schema still resolves. Must throw
 *                                      404 when absent, refuse a different owner,
 *                                      and enforce any engine interlock.
 * @param {Function} [config.mirrorSize]   (entityId, ownerId, bytes) — fire-and-forget
 *                                      metadata mirror so list reads stay join-free.
 * @param {Function} [config.clearMeta]    async (client, entityId, ownerId) — zero that
 *                                      metadata when the schema is dropped.
 */
function createPgAppEngine({
    runQuery, getClient, logPrefix, entityLabel, schemaFor,
    assertAccess: assertAccessFn,
    mirrorSize: mirrorSizeFn,
    clearMeta: clearMetaFn,
} = /** @type {any} */ ({})) {
    if (typeof runQuery !== 'function' || typeof getClient !== 'function'
        || !logPrefix || !entityLabel || typeof schemaFor !== 'function') {
        throw new Error('createPgAppEngine requires runQuery, getClient, logPrefix, entityLabel, schemaFor');
    }

    // appId → { ownerId, engine, ts } — the 60 s ownership/interlock cache.
    const ownershipCache = new Map();
    // appId → { bytes, ts } — the 30 s sizeBytes cache.
    const sizeCache = new Map();

    const ctx = {
        runQuery, getClient, logPrefix, entityLabel, schemaFor,
        assertAccessFn, mirrorSizeFn, clearMetaFn, ownershipCache, sizeCache,
    };
    const tx = makeTx(ctx);
    const txCtx = { ...ctx, ...tx };
    const statements = makeStatements(txCtx);
    const migration = makeMigration(txCtx);
    const inspect = makeInspect(txCtx);
    const lifecycle = makeLifecycle(txCtx);

    return {
        query: statements.query,
        exec: statements.exec,
        batch: statements.batch,
        applyMigration: migration.applyMigration,
        getSchemaStamp: migration.getSchemaStamp,
        schema: inspect.schema,
        sizeBytes: inspect.sizeBytes,
        reset: lifecycle.reset,
        flush: lifecycle.flush,
        invalidate: lifecycle.invalidate,
        closeAll: lifecycle.closeAll,
        // Test-only
        _ownershipCache: ownershipCache,
        _sizeCache: sizeCache,
        _normalizeParams: normalizeParams,
    };
}

module.exports = {
    createPgAppEngine,
    toDollarParams,
    mapPgError,
    _normalizeRows: normalizeRows,
    _dateOnlyString: dateOnlyString,
};
