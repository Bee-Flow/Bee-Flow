// @typecheck
/**
 * SQLite-blob engine — the shared core behind studioAppDbStore and
 * webpageDbStore (which was forked into the studio store; this factory
 * replaces both copies with one hardened implementation).
 *
 * Each entity (webpage / studio app) has at most one SQLite database file
 * (`data.db`) stored as a blob in RustFS under a per-owner prefix. An engine
 * instance owns the live `better-sqlite3` handles: it lazy-loads the blob to a
 * server-local file on first access, runs queries in-process, then
 * debounce-flushes the file back to RustFS after writes.
 *
 *   ┌─ getHandle ──────────────────┐
 *   │ load data.db from RustFS     │
 *   │ → {workDir}/{id}.db          │
 *   │ open with better-sqlite3     │
 *   └────────┬─────────────────────┘
 *            │
 *   ┌────────▼─────────┐    write?    ┌──────────────────┐
 *   │ query / exec     │─── dirty ───▶│ scheduleFlush    │
 *   │ / batch / schema │              │ (5 s debounce)   │
 *   └──────────────────┘              └──────┬───────────┘
 *                                            │
 *                                ┌───────────▼─────────────┐
 *                                │ upload to RustFS, write │
 *                                │ db_sha256 / db_size back│
 *                                │ to {metaTable}          │
 *                                └─────────────────────────┘
 *
 * ── TRUST BOUNDARY / SECURITY ───────────────────────────────────────
 * Engine methods are MODULE-INTERNAL to their wrapping store: they are only
 * ever called by code that generates SQL from a validated contract, never by a
 * route handler with client-supplied SQL. Authorization is the caller's
 * responsibility — the engine never reaches back to req.session. The `ownerId`
 * argument is a trust boundary: the caller must have verified the user owns
 * (or may write) the entity. The handle Map refuses to serve a cached handle
 * to a different ownerId.
 *
 * ── DEPENDENCY INJECTION (load-bearing, not style) ──────────────────
 * `storage` and `runQuery` are injected by the wrapper instead of required
 * here: the wrappers' pinned tests stub the require strings './storageStore'
 * and '../db' AS WRITTEN IN THE WRAPPER. If the engine required them itself,
 * those stubs would silently miss and the "DB-free" suites would drag in the
 * real pg pool. Do not "simplify" this into direct requires.
 *
 * ── MULTI-REPLICA (future) ──────────────────────────────────────────
 * getWriteHandle / getReadHandle both resolve to the same in-process handle
 * today (single-replica). The accessors exist so future lease-based
 * write-affinity routing has a single seam to change without touching callers.
 */

const { createFlusher } = require('./sqliteBlobFlush');
const { createHandleLoader } = require('./sqliteBlobHandles');
const { createReadApi, createWriteApi, normalizeParams } = require('./sqliteBlobStatements');
const { createStorageOps, createCloseOps } = require('./sqliteBlobLifecycle');

/**
 * Build one engine instance.
 *
 * @param {object} config
 * @param {string}   config.workDir     Absolute dir for local .db materialisation
 *                                      (wrapper resolves its env-var fallback).
 * @param {Function} config.buildKey    (ownerId, id) => RustFS object key.
 * @param {string}   config.metaTable   Postgres table for the db_sha256/db_size
 *                                      metadata UPDATEs (column set is identical
 *                                      across both stores and stays hard-coded).
 * @param {string}   config.logPrefix   Console tag, e.g. 'StudioAppDB' → `[StudioAppDB] …`.
 * @param {string}   config.entityLabel Error noun, e.g. 'Studio App DB' →
 *                                      `Studio App DB handle owned by another user — …`.
 * @param {object}   config.storage     storageStore-shaped: isAvailable(),
 *                                      streamFile(key), uploadFile(key, buf, ct),
 *                                      deleteFile(key). Injected — see header.
 * @param {Function} config.runQuery    async (sql, params) => result. Wrappers pass db.run.
 * @param {Function} [config.assertServable] optional guard run before a handle is served.
 */
function createSqliteBlobEngine({ workDir, buildKey, metaTable, logPrefix, entityLabel, storage, runQuery, assertServable } = /** @type {any} */ ({})) {
    if (!workDir || typeof buildKey !== 'function' || !metaTable || !logPrefix || !entityLabel
        || !storage || typeof runQuery !== 'function') {
        throw new Error('createSqliteBlobEngine requires workDir, buildKey, metaTable, logPrefix, entityLabel, storage, runQuery');
    }

    // In-memory registry of open handles, keyed by entity id.
    // {
    //   db: Database,
    //   ownerId: string,
    //   localPath: string,
    //   lastAccess: number,
    //   dirty: boolean,
    //   flushTimer: NodeJS.Timeout | null,
    //   flushing: Promise<void> | null,
    //   lastPersistedSha: string,   // metaTable.db_sha256 as of load / last flush
    //   poisoned: boolean,          // another replica flushed over us — refuse writes
    // }
    const handles = new Map();

    function dbKey(ownerId, id) {
        return buildKey(ownerId, id);
    }

    // Write-back (debounced, sha-gated flush; eviction) and load (cold open,
    // owner check) share the handle Map; the APIs below sit on top of both.
    const { scheduleFlush, flushNow, maybeEvict } = createFlusher({ handles, dbKey, storage, runQuery, metaTable, logPrefix, entityLabel });
    const { getHandle, localPathFor } = createHandleLoader({ handles, maybeEvict, dbKey, workDir, storage, runQuery, metaTable, entityLabel, assertServable });

    // ── Public API (module-internal — see security note at top) ─────
    const { getReadHandle, query, schema } = createReadApi({ getHandle });
    const { getWriteHandle, exec, batch, applyMigration } = createWriteApi({ getHandle, scheduleFlush, entityLabel });
    const { sizeBytes, reset } = createStorageOps({ handles, localPathFor, dbKey, storage, runQuery, metaTable, entityLabel });
    const { flush, invalidate, closeAll } = createCloseOps({ handles, localPathFor, flushNow, logPrefix, entityLabel });

    // Best-effort flush on shutdown. The handlers must not throw or the
    // process will exit non-zero on SIGTERM. Per-instance, exactly like the
    // two pre-factory modules each wired their own.
    let shutdownWired = false;
    function wireShutdown() {
        if (shutdownWired) return;
        shutdownWired = true;
        const handler = () => {
            closeAll().catch(() => {}).finally(() => {
                // Don't process.exit() — let the rest of the app's shutdown finish.
            });
        };
        process.on('SIGTERM', handler);
        process.on('SIGINT', handler);
        process.on('beforeExit', handler);
    }
    wireShutdown();

    return {
        getWriteHandle,
        getReadHandle,
        query,
        exec,
        batch,
        applyMigration,
        schema,
        sizeBytes,
        reset,
        flush,
        invalidate,
        closeAll,
        // Test-only
        _handles: handles,
        _normalizeParams: normalizeParams,
    };
}

module.exports = { createSqliteBlobEngine };
