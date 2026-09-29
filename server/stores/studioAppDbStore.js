// @typecheck
/**
 * Studio App DB Store — the ENGINE SWITCH for the App Studio DATA ENGINE
 * (per-app database). Exposes ONE frozen facade (contract below) and wires it,
 * at module load, to the engine STUDIO_APP_ENGINE selects:
 *
 *   'sqlite' (default)  stores/lib/sqliteBlobEngine — per-app data.db blob in
 *                       RustFS, handle map, LRU eviction, sha-gated debounced
 *                       flush. Unchanged behavior, byte for byte.
 *   'pg'                stores/lib/pgAppEngine — per-app Postgres SCHEMA
 *                       (app_<appId>) inside the existing beeflow_core DB.
 *
 * The env flag picks THIS REPLICA's engine; the per-app safety interlock is
 * studio_apps.engine, which the selected engine verifies before touching an
 * app (pg refuses non-'pg' apps with { code: 'engine_mismatch' }; the sqlite
 * side of that interlock lands with the B3 migrator).
 *
 * ── TRUST BOUNDARY / SECURITY ───────────────────────────────────────
 * This store is MODULE-INTERNAL. Its query/exec/batch/applyMigration are ONLY
 * ever called by dataModel.js / queryCompiler consumers / studioAppDataStore.js
 * — code that generates SQL from a *validated* data-model contract. They are
 * NEVER called by a route handler with client-supplied SQL. The App Studio
 * surface exposes structured record operations (list/get/create/update over a
 * table+filter descriptor), never raw SQL. Do not add a route that pipes user
 * SQL into these functions.
 *
 * Authorization is the caller's responsibility — this module never reaches
 * back to req.session. The `ownerId` argument is a trust boundary: the caller
 * must have verified the user owns (or may write) the app. Both engines refuse
 * to serve a different ownerId.
 *
 * ── MULTI-REPLICA ───────────────────────────────────────────────────
 * sqlite: single-replica (see sqliteBlobEngine's sha-gate notes); studio_apps
 * carries db_lease_owner / db_lease_expires_at reserved for future
 * write-affinity routing. pg: multi-replica is native — every call is one
 * Postgres transaction.
 */

const path = require('path');
const os = require('os');

const { isPg } = require('../utils/engineFlag');

// ── THE ENGINE FACADE CONTRACT (frozen seam) ────────────────────────────────
// Both engines implement exactly this:
//   query(ownerId, appId, sql, params)  -> { rows, columns, truncated }
//   exec(ownerId, appId, sql, params)   -> { changes, lastInsertRowid? }
//   batch(ownerId, appId, statements)   -> [{ rows } | { changes }]   (one tx)
//   applyMigration(ownerId, appId, ddl, { targetVersion }) -> { applied, skipped }
//   getSchemaStamp(ownerId, appId)      -> number
//   schema(ownerId, appId)              -> { tables: [...] }
//   sizeBytes(ownerId, appId)           -> number (authoritative)
//   reset / flush / invalidate / closeAll
// Raw handles (getWriteHandle/getReadHandle) are deliberately NOT exported:
// every caller that needs the database goes through the contract above, so
// either engine drops in behind this module without touching callers.

// STUDIO_APP_ENGINE is read ONCE, here, at module load: a replica runs exactly
// one engine for its whole lifetime. (engineFlag re-reads env per call for the
// COMPILER dialect, which tests toggle; the wiring below does not follow a
// mid-flight flip and must not.)
if (isPg()) {
    // ── Postgres engine ─────────────────────────────────────────────
    const db = require('../db');
    const { createPgAppEngine } = require('./lib/pgAppEngine');

    const engine = createPgAppEngine({
        runQuery: db.run,
        getClient: db.getClient,
        logPrefix: 'StudioAppDB',
        entityLabel: 'Studio App DB',
        // Dashes kept: 'app_' + a 36-char UUID = 40 chars, safely inside PG's
        // 63-char identifier limit. Always quoted by the engine.
        schemaFor: (appId) => 'app_' + appId,
    });

    module.exports = {
        query: engine.query,
        exec: engine.exec,
        batch: engine.batch,
        // pg applyMigration is natively tolerant (per-statement savepoints skip
        // duplicate column/table SQLSTATEs) and stamps _meta.schema_stamp in
        // the same transaction — the equivalent of the sqlite override below.
        applyMigration: engine.applyMigration,
        getSchemaStamp: engine.getSchemaStamp,
        schema: engine.schema,
        sizeBytes: engine.sizeBytes,
        reset: engine.reset,
        flush: engine.flush,
        invalidate: engine.invalidate,
        closeAll: engine.closeAll,
        // Test-only (surface kept identical across engines; pg has no handles)
        _handles: new Map(),
        _normalizeParams: engine._normalizeParams,
    };
} else {
    // ── SQLite blob engine (default) ────────────────────────────────
    const storageStore = require('./storageStore');
    const { run } = require('../db');
    const { createSqliteBlobEngine } = require('./lib/sqliteBlobEngine');
    const { applyPlanTolerantly } = require('../appStudio/dataModel');

    const engine = createSqliteBlobEngine({
        workDir: process.env.STUDIO_APP_DB_WORK_DIR || path.join(os.tmpdir(), 'beeflow-studio-app-dbs'),
        buildKey: (ownerId, appId) => storageStore.buildStudioAppKey(ownerId, appId),
        metaTable: 'studio_apps',
        logPrefix: 'StudioAppDB',
        entityLabel: 'Studio App DB',
        storage: storageStore,
        runQuery: run,
        // The sqlite half of the engine interlock: an app the migrator has
        // already moved to Postgres must NOT be served from its (now frozen)
        // blob. Without this, a replica still running the sqlite engine would
        // read stale rows and write changes nobody will ever see again.
        assertServable: async (ownerId, appId) => {
            let engineName = null;
            try {
                const res = await run(`SELECT engine FROM studio_apps WHERE id = $1 AND user_id = $2`, [appId, ownerId]);
                engineName = res?.rows?.[0]?.engine ?? null;
            } catch (_) {
                return; // unreadable metadata is not proof of a migration
            }
            if (engineName === 'pg') {
                const err = new Error('This app has been migrated to the Postgres engine — this replica is still on sqlite (set STUDIO_APP_ENGINE=pg).');
                err.code = 'engine_mismatch';
                err.status = 503;
                throw err;
            }
        },
    });

    /**
     * Apply a migration plan — a studio-specific override of the shared engine's
     * applyMigration (webpageDbStore keeps the plain engine one):
     *
     *   • statements run through dataModel.applyPlanTolerantly, which skips ONLY
     *     the exact "already applied" signatures (duplicate ADD COLUMN, completed
     *     renames) so a replay after a failed Postgres commit succeeds;
     *   • with { targetVersion } the plan's transaction ALSO stamps
     *     PRAGMA user_version = targetVersion. saveDataModel passes the next
     *     model_version, making user_version > model_version the detectable
     *     fingerprint of the SQLite-ahead-of-Postgres window
     *     (studioAppDataStore.reconcileDataModel reads it via getUserVersion).
     *
     * Everything runs in ONE better-sqlite3 transaction — all-or-nothing exactly
     * like the engine version (PRAGMA user_version is journaled, so a rollback
     * also restores the old stamp). Afterwards the handle is flushed through the
     * engine immediately (not debounced): schema changes are rare and must be
     * durable in RustFS before the caller's Postgres commit.
     *
     * Returns { applied, skipped: [{ sql, reason }] }.
     */
    async function applyMigration(ownerId, id, orderedDDL, { targetVersion = null } = {}) {
        if (!Array.isArray(orderedDDL)) {
            throw new Error('applyMigration requires an array of DDL strings');
        }
        if (orderedDDL.length > 500) {
            throw new Error('applyMigration supports at most 500 statements per call');
        }
        const stampVersion = (Number.isInteger(targetVersion) && targetVersion >= 0) ? targetVersion : null;
        if (orderedDDL.length === 0 && stampVersion === null) return { applied: 0, skipped: [] };

        const entry = await engine.getWriteHandle(ownerId, id);
        // This override reaches past the engine's write guards (it holds entry.db
        // directly), so the poisoned check is repeated here: migrating a database
        // another replica has since flushed over would build schema on doomed bytes.
        if (entry.poisoned) {
            throw new Error('Studio App DB is stale: another replica has written this database — refresh required');
        }
        const tx = entry.db.transaction(() => {
            const res = applyPlanTolerantly(entry.db, orderedDDL);
            if (stampVersion !== null) entry.db.pragma(`user_version = ${stampVersion}`);
            return res;
        });
        const { applied, skipped } = tx();
        // Persist through the engine's own flush pipeline (RustFS blob +
        // studio_apps db_sha256/db_size metadata). `dirty` is the handle contract
        // the engine's own write paths set before scheduling a flush.
        entry.dirty = true;
        await engine.flush(ownerId, id);
        return { applied, skipped };
    }

    /**
     * The engine-agnostic schema stamp: which migration generation the physical
     * database is at. SQLite backs it with PRAGMA user_version (0 when never
     * stamped / no db yet); the PG engine backs it with _meta.schema_stamp.
     */
    async function getSchemaStamp(ownerId, id) {
        const entry = await engine.getReadHandle(ownerId, id);
        const v = entry.db.pragma('user_version', { simple: true });
        return Number.isFinite(v) ? v : (parseInt(v, 10) || 0);
    }

    module.exports = {
        query: engine.query,
        exec: engine.exec,
        batch: engine.batch,
        applyMigration,
        getSchemaStamp,
        schema: engine.schema,
        sizeBytes: engine.sizeBytes,
        reset: engine.reset,
        flush: engine.flush,
        invalidate: engine.invalidate,
        closeAll: engine.closeAll,
        // Test-only
        _handles: engine._handles,
        _normalizeParams: engine._normalizeParams,
    };
}
