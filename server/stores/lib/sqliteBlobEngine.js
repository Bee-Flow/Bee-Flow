// @typecheck strict
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
const { createStatementRunner } = require('./sqliteStatementRunner');
const { createStorageOps, createCloseOps } = require('./sqliteBlobLifecycle');
const { fallback } = require('../../utils/bestEffort');

/**
 * Build one engine instance.
 *
 * @param {{
 *   workDir: string, buildKey: (ownerId: string, id: string) => string, metaTable: string, logPrefix: string,
 *   entityLabel: string, storage: Pick<typeof import('../storageStore'), 'isAvailable' | 'streamFile' | 'uploadFile' | 'deleteFile'>,
 *   runQuery: typeof import('../../db').run, assertServable?: (ownerId: string, id: string) => Promise<unknown>,
 *   statementTimeoutMs?: number,
 * }} config
 *   workDir: absolute dir for local .db materialisation (wrapper resolves its env-var fallback).
 *   buildKey: (ownerId, id) => RustFS object key. metaTable: Postgres table for the db_sha256/db_size
 *   metadata UPDATEs (column set is identical across both stores and stays hard-coded).
 *   logPrefix: console tag, e.g. 'StudioAppDB' → `[StudioAppDB] …`. entityLabel: error noun, e.g.
 *   'Studio App DB' → `Studio App DB handle owned by another user — …`. storage: storageStore-shaped,
 *   injected — see header. runQuery: wrappers pass db.run. assertServable: optional guard run before
 *   a handle is served. statementTimeoutMs: the deadline of one statement (default from
 *   SQLITE_STATEMENT_TIMEOUT_MS, see sqliteStatementRunner.js; 0 = none, in-process).
 */
function createSqliteBlobEngine({ workDir, buildKey, metaTable, logPrefix, entityLabel, storage, runQuery, assertServable, statementTimeoutMs } = /** @type {NonNullable<Parameters<typeof createSqliteBlobEngine>[0]>} */ ({})) {
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

    /**
     * @param {string} ownerId
     * @param {string} id
     */
    function dbKey(ownerId, id) {
        return buildKey(ownerId, id);
    }

    // Write-back (debounced, sha-gated flush; eviction) and load (cold open,
    // owner check) share the handle Map; the APIs below sit on top of both.
    const { scheduleFlush, flushNow, maybeEvict } = createFlusher({ handles, dbKey, storage, runQuery, metaTable, logPrefix, entityLabel });
    const { getHandle, localPathFor } = createHandleLoader({ handles, maybeEvict, dbKey, workDir, storage, runQuery, metaTable, entityLabel, assertServable });

    // Statements run in the engine's statement process under a deadline
    // (./sqliteStatementRunner.js); the handles above stay the flusher's.
    const runner = createStatementRunner({
        ...(statementTimeoutMs !== undefined ? { timeoutMs: statementTimeoutMs } : {}), entityLabel, logPrefix,
    });

    // ── Public API (module-internal — see security note at top) ─────
    const { getReadHandle, query, schema } = createReadApi({ getHandle, runner });
    const { getWriteHandle, exec, batch, applyMigration } = createWriteApi({ getHandle, scheduleFlush, entityLabel, runner });
    const { sizeBytes, reset } = createStorageOps({ handles, localPathFor, dbKey, storage, runQuery, metaTable, entityLabel });
    const { flush, invalidate, closeAll: closeHandles } = createCloseOps({ handles, localPathFor, flushNow, logPrefix, entityLabel });

    /** Flush and close every handle, then end the statement process. */
    async function closeAll() {
        try { await closeHandles(); } finally { runner.stop(); }
    }

    // Best-effort flush on shutdown. The handlers must not throw or the
    // process will exit non-zero on SIGTERM. Per-instance, exactly like the
    // two pre-factory modules each wired their own.
    let shutdownWired = false;
    function wireShutdown() {
        if (shutdownWired) return;
        shutdownWired = true;
        const handler = () => {
            closeAll().catch((e) => fallback('stores/lib/sqliteBlobEngine:handler', e)).finally(() => {
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
        _runner: runner,
    };
}

module.exports = { createSqliteBlobEngine };
