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

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const log = require('../../telemetry/log');

const FLUSH_DEBOUNCE_MS = 5000;
const MAX_OPEN_HANDLES = 32;
const MAX_SQL_BYTES = 500_000;
const MAX_RESULT_ROWS = 10_000;

// ── Pure helpers (stateless — shared across engine instances) ───────

function validateSql(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('sql must be a non-empty string');
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        throw new Error(`sql is larger than the ${MAX_SQL_BYTES}-byte limit`);
    }
}

function normalizeParams(params) {
    if (params === undefined || params === null) return [];
    if (!Array.isArray(params)) {
        throw new Error('params must be an array (positional ? placeholders)');
    }
    return params.map(v => {
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'bigint') return v;
        // better-sqlite3 only binds numbers/strings/bigints/buffers/null — a raw
        // boolean throws a TypeError at bind time. SQLite has no boolean type
        // anyway (its docs recommend 0/1), so coerce here rather than pushing
        // this footgun onto every caller.
        if (t === 'boolean') return v ? 1 : 0;
        if (Buffer.isBuffer(v)) return v;
        // Objects/arrays aren't natively supported by SQLite — stringify so the
        // caller doesn't have to remember to JSON.stringify themselves.
        return JSON.stringify(v);
    });
}

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

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

    // In-flight cold opens, keyed by entity id. Concurrent misses for the same
    // entity share ONE download: without this, two requests racing a cold start
    // both unlink the local file, both download, and the second handles.set()
    // orphans the first's open db handle — 50 viewers opening the same app at
    // 09:00 is exactly the trigger.
    const loading = new Map();

    let workDirReady = false;
    async function ensureWorkDir() {
        if (workDirReady) return;
        await fsp.mkdir(workDir, { recursive: true });
        workDirReady = true;
    }

    function localPathFor(id) {
        return path.join(workDir, `${id}.db`);
    }

    function dbKey(ownerId, id) {
        return buildKey(ownerId, id);
    }

    async function downloadIfExists(ownerId, id, localPath) {
        if (!storage.isAvailable()) return false;
        try {
            const { stream } = await storage.streamFile(dbKey(ownerId, id));
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            await fsp.writeFile(localPath, Buffer.concat(chunks));
            return true;
        } catch (err) {
            if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return false;
            throw err;
        }
    }

    async function getHandle(ownerId, id) {
        await ensureWorkDir();
        const existing = handles.get(id);
        if (existing) {
            // Trust boundary: a different ownerId asking for the same id means
            // an authorization bug upstream — refuse rather than serve it.
            if (existing.ownerId !== ownerId) {
                throw new Error(`${entityLabel} handle owned by another user — refusing to share`);
            }
            existing.lastAccess = Date.now();
            return existing;
        }

        // Coalesce concurrent cold opens onto one download. The trust check
        // must hold for coalesced waiters too — the first caller's ownerId did
        // the download, so a different ownerId arriving mid-flight is refused
        // exactly like a cached-handle mismatch.
        const inflight = loading.get(id);
        if (inflight) {
            const entry = await inflight;
            if (entry.ownerId !== ownerId) {
                throw new Error(`${entityLabel} handle owned by another user — refusing to share`);
            }
            entry.lastAccess = Date.now();
            return entry;
        }
        const opening = openCold(ownerId, id);
        loading.set(id, opening);
        try {
            return await opening;
        } finally {
            loading.delete(id);
        }
    }

    async function openCold(ownerId, id) {
        // Optional per-entity gate, checked ONCE per handle lifetime (a refused
        // entity never gets a handle, so there is nothing to cache). The studio
        // wiring uses it to refuse apps already migrated to the Postgres
        // engine: a replica still on sqlite would otherwise happily serve — and
        // write to — a database the fleet has moved off.
        if (typeof assertServable === 'function') await assertServable(ownerId, id);

        const localPath = localPathFor(id);
        // Drop any stale local copy (and its rollback/WAL companions) from a
        // previous restore/eviction so we always start from the authoritative
        // RustFS state. journal_mode = DELETE below keeps the .db blob
        // self-contained — no -wal/-shm to upload — but a process killed mid-write
        // may have left stragglers.
        for (const ext of ['', '-journal', '-wal', '-shm']) {
            try { await fsp.unlink(localPath + ext); } catch (_) {}
        }
        await downloadIfExists(ownerId, id, localPath);

        // The sha the metadata row currently names. This is the flush gate's
        // baseline: our first flush only lands if the row STILL names this
        // value — if another replica flushed in between, the row moved and we
        // must not overwrite its blob. Reading the ROW (not hashing the
        // download) also self-heals the crashed-mid-flush case where the row
        // is ahead of the blob. Best-effort: an unreadable row leaves '' and
        // the gate's COALESCE match still covers the never-flushed case.
        let persistedSha = '';
        try {
            const res = await runQuery(
                `SELECT db_sha256 FROM ${metaTable} WHERE id = $1 AND user_id = $2`,
                [id, ownerId]
            );
            persistedSha = String(res?.rows?.[0]?.db_sha256 || '');
        } catch (_) {}

        const db = new Database(localPath);
        // DELETE journaling keeps everything in a single .db file at rest — no
        // sidecar files to track between request lifetimes. This is strictly
        // single-process per entity (the handle Map enforces it), so we don't
        // need WAL's concurrent-reader benefit.
        try { db.pragma('journal_mode = DELETE'); } catch (_) {}
        try { db.pragma('foreign_keys = ON'); } catch (_) {}

        const entry = {
            db,
            ownerId,
            localPath,
            lastAccess: Date.now(),
            dirty: false,
            flushTimer: null,
            flushing: null,
            lastPersistedSha: persistedSha,
            poisoned: false,
        };
        handles.set(id, entry);
        await maybeEvict();
        return entry;
    }

    async function maybeEvict() {
        if (handles.size <= MAX_OPEN_HANDLES) return;
        const sorted = [...handles.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        const overflow = sorted.length - MAX_OPEN_HANDLES;
        for (let i = 0; i < overflow; i++) {
            const [id, entry] = sorted[i];
            try {
                if (entry.dirty && !entry.poisoned) await flushNow(id);
            } catch (e) {
                log.warn(`[${logPrefix}] Evict flush failed for ${id}:`, e.message);
            }
            try { entry.db.close(); } catch (_) {}
            if (entry.flushTimer) clearTimeout(entry.flushTimer);
            handles.delete(id);
        }
    }

    function scheduleFlush(id) {
        const entry = handles.get(id);
        if (!entry) return;
        entry.dirty = true;
        // A pending timer stays put. Resetting it on every write meant a
        // steadily-written entity NEVER flushed — the debounce became an
        // unbounded durability window, bounded only by eviction or shutdown.
        // Leaving the timer gives a hard ceiling of FLUSH_DEBOUNCE_MS between
        // the first unflushed write and its upload.
        if (entry.flushTimer) return;
        entry.flushTimer = setTimeout(() => {
            entry.flushTimer = null;
            flushNow(id).catch(err =>
                log.error(`[${logPrefix}] Background flush failed for ${id}:`, err.message));
        }, FLUSH_DEBOUNCE_MS);
    }

    /**
     * Force-flush the on-disk DB file back to RustFS and update Postgres
     * metadata ({metaTable}.db_sha256 / db_size). Coalesces concurrent callers
     * onto a single in-flight upload.
     *
     * The flush is SHA-GATED against multi-replica clobbering: the metadata
     * UPDATE is conditional on db_sha256 still being the value this handle
     * loaded (or last flushed). Runs BEFORE the blob upload, so when another
     * replica has flushed in between, this replica's stale bytes never
     * overwrite the newer blob — the handle is poisoned instead and every
     * subsequent write throws a clear error. Detection, not prevention: real
     * multi-replica writing needs the PG engine (or lease routing); this gate
     * turns silent last-flush-wins data loss into a loud refusal.
     */
    async function flushNow(id) {
        const entry = handles.get(id);
        if (!entry) return;
        if (entry.flushing) return entry.flushing;
        if (entry.poisoned) {
            throw new Error(`${entityLabel} is stale: another replica has written this database — refusing to flush`);
        }

        entry.flushing = (async () => {
            try {
                // Cleared up front so a write landing mid-flush re-marks it —
                // clearing at the end (as before) let closeAll/evict skip a
                // flush whose bytes were newer than the upload in flight.
                entry.dirty = false;
                const buf = await fsp.readFile(entry.localPath);
                const sha = crypto.createHash('sha256').update(buf).digest('hex');
                const prevSha = entry.lastPersistedSha || '';
                if (sha === prevSha) return; // nothing actually changed — the documented sha-gate, now real

                // Gate FIRST, upload second: a conditional match failure means
                // the row moved (another replica flushed) and our upload would
                // clobber a blob that is newer than our copy.
                const res = await runQuery(
                    `UPDATE ${metaTable} SET db_sha256 = $1, db_size = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 AND COALESCE(db_sha256, '') = $5`,
                    [sha, buf.length, id, entry.ownerId, prevSha]
                );
                const rowCount = (res && typeof res.rowCount === 'number') ? res.rowCount
                    : (res && typeof res.changes === 'number') ? res.changes : null;
                let gateMatched = rowCount !== 0;
                if (!gateMatched) {
                    // Distinguish a MOVED row (foreign flush — poison) from a
                    // MISSING row (entity deleted mid-flight, or a deployment
                    // without the metadata row): only a proven different sha
                    // is a foreign writer. A missing/unreadable row keeps the
                    // old fire-and-forget behavior — upload, skip metadata.
                    let rowSha = null;
                    try {
                        const check = await runQuery(
                            `SELECT db_sha256 FROM ${metaTable} WHERE id = $1 AND user_id = $2`,
                            [id, entry.ownerId]
                        );
                        rowSha = check?.rows?.[0]?.db_sha256 ?? null;
                    } catch (_) {}
                    if (rowSha !== null && String(rowSha || '') !== prevSha) {
                        entry.poisoned = true;
                        entry.dirty = true;
                        log.error(`[${logPrefix}] Flush REFUSED for ${id}: metadata sha moved under us (another replica?) — handle poisoned, writes will error`);
                        throw new Error(`${entityLabel} was modified by another replica — refusing to overwrite`);
                    }
                }
                try {
                    if (storage.isAvailable()) {
                        await storage.uploadFile(dbKey(entry.ownerId, id), buf, 'application/vnd.sqlite3');
                    }
                } catch (uploadErr) {
                    // The row may now name a sha whose blob never landed — put
                    // the old value back (best-effort) so a cold open elsewhere
                    // doesn't read a phantom sha, and keep dirty so the retry
                    // path re-runs the whole cycle.
                    if (gateMatched) {
                        try {
                            await runQuery(
                                `UPDATE ${metaTable} SET db_sha256 = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND db_sha256 = $4`,
                                [prevSha, id, entry.ownerId, sha]
                            );
                        } catch (_) {}
                    }
                    entry.dirty = true;
                    throw uploadErr;
                }
                if (gateMatched) entry.lastPersistedSha = sha;
            } catch (err) {
                if (!entry.poisoned) entry.dirty = true;
                throw err;
            } finally {
                entry.flushing = null;
            }
        })();
        return entry.flushing;
    }

    // ── Public API (module-internal — see security note at top) ─────

    /**
     * Return the writable handle. In single-replica mode this is just
     * getHandle; the accessor exists so future lease-based multi-replica
     * routing has a single seam to change without touching every caller.
     */
    async function getWriteHandle(ownerId, id) {
        return getHandle(ownerId, id);
    }

    // A poisoned handle detected a foreign flush (see flushNow) — accepting
    // more writes would grow a local state that can never be persisted.
    function assertWritable(entry) {
        if (entry.poisoned) {
            throw new Error(`${entityLabel} is stale: another replica has written this database — refresh required`);
        }
    }

    /**
     * Return a read handle. Identical to getWriteHandle today — reads and
     * writes share the in-process handle. Kept separate to document read
     * intent and to leave room for read-replica routing later.
     */
    async function getReadHandle(ownerId, id) {
        return getHandle(ownerId, id);
    }

    /**
     * Run a read-only SELECT. Errors if the SQL isn't read-only (per
     * better-sqlite3's `prepare().readonly` check) so write paths can't sneak
     * in via the query entry point.
     */
    async function query(ownerId, id, sql, params = []) {
        validateSql(sql);
        const entry = await getReadHandle(ownerId, id);
        const stmt = entry.db.prepare(sql);
        if (!stmt.readonly) {
            throw new Error('query() refuses to run a statement that mutates the database — use exec() instead');
        }
        const safeParams = normalizeParams(params);
        const rows = safeParams.length ? stmt.all(...safeParams) : stmt.all();
        if (rows.length > MAX_RESULT_ROWS) {
            rows.length = MAX_RESULT_ROWS;
        }
        const columns = (stmt.columns?.() || []).map(c => c.name);
        return { rows, columns, truncated: rows.length === MAX_RESULT_ROWS };
    }

    /**
     * Run a single write or DDL statement. With `params` empty, accepts
     * multi-statement SQL (e.g. several CREATE TABLEs at once) via `db.exec`.
     * With `params`, runs a single prepared statement and returns
     * `{ changes, lastInsertRowid }`.
     */
    async function exec(ownerId, id, sql, params = []) {
        validateSql(sql);
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const safeParams = normalizeParams(params);

        let result;
        if (safeParams.length === 0 && /;\s*\S/.test(sql.trim())) {
            // Multi-statement script (no params): use db.exec which doesn't
            // return per-statement counts but can run several statements.
            entry.db.exec(sql);
            result = { changes: 0, lastInsertRowid: 0, multi: true };
        } else {
            const r = entry.db.prepare(sql).run(...safeParams);
            result = {
                changes: r.changes,
                lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
            };
        }
        scheduleFlush(id);
        return result;
    }

    /**
     * Run a series of statements in a single transaction. Each statement is
     * `{ sql, params? }`. Returns an array of per-statement results. At most
     * 500 statements per call.
     */
    async function batch(ownerId, id, statements) {
        if (!Array.isArray(statements) || statements.length === 0) {
            throw new Error('batch() requires a non-empty statements array');
        }
        if (statements.length > 500) {
            throw new Error('batch() supports at most 500 statements per call');
        }
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const tx = entry.db.transaction((stmts) => {
            const results = [];
            for (const s of stmts) {
                validateSql(s?.sql);
                const params = normalizeParams(s?.params);
                const stmt = entry.db.prepare(s.sql);
                if (stmt.readonly) {
                    const rows = params.length ? stmt.all(...params) : stmt.all();
                    results.push({ rows: rows.slice(0, MAX_RESULT_ROWS) });
                } else {
                    const r = params.length ? stmt.run(...params) : stmt.run();
                    results.push({
                        changes: r.changes,
                        lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
                    });
                }
            }
            return results;
        });
        const results = tx(statements);
        scheduleFlush(id);
        return results;
    }

    /**
     * Apply an ordered list of DDL statements (a migration plan) inside ONE
     * transaction — all-or-nothing, so a half-applied schema change can never
     * be flushed. Each entry is a SQL string. Returns { applied: N }.
     */
    async function applyMigration(ownerId, id, orderedDDL) {
        if (!Array.isArray(orderedDDL)) {
            throw new Error('applyMigration requires an array of DDL strings');
        }
        if (orderedDDL.length === 0) return { applied: 0 };
        if (orderedDDL.length > 500) {
            throw new Error('applyMigration supports at most 500 statements per call');
        }
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const tx = entry.db.transaction((ddls) => {
            let applied = 0;
            for (const ddl of ddls) {
                validateSql(ddl);
                // Migration DDL may itself be multi-statement (e.g. add-column +
                // backfill); db.exec handles both single and multi.
                entry.db.exec(ddl);
                applied++;
            }
            return applied;
        });
        const applied = tx(orderedDDL);
        scheduleFlush(id);
        return { applied };
    }

    /**
     * Inspect the schema — tables, their columns, and column types.
     */
    async function schema(ownerId, id) {
        const entry = await getReadHandle(ownerId, id);
        const tables = entry.db
            .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all();
        const out = [];
        for (const t of tables) {
            const cols = entry.db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
            out.push({
                name: t.name,
                sql: t.sql,
                columns: cols.map(c => ({
                    name: c.name,
                    type: c.type,
                    notNull: !!c.notnull,
                    defaultValue: c.dflt_value,
                    primaryKey: !!c.pk,
                })),
            });
        }
        return { tables: out };
    }

    /**
     * On-disk size of the entity's database in bytes (0 when no db file exists
     * yet). Reads the local materialised file — call after getHandle to be
     * sure it's present, or it returns 0 for a not-yet-loaded entity.
     */
    async function sizeBytes(ownerId, id) {
        const entry = handles.get(id);
        if (entry) {
            if (entry.ownerId !== ownerId) {
                throw new Error(`${entityLabel} handle owned by another user — refusing to size`);
            }
            try {
                const stat = await fsp.stat(entry.localPath);
                return stat.size;
            } catch (_) { return 0; }
        }
        try {
            const stat = await fsp.stat(localPathFor(id));
            return stat.size;
        } catch (_) {}
        // Cold replica: no handle and no local file, but the entity may be real
        // and LARGE — fall back to the last flushed metadata size so byte
        // quotas hold on every replica, not only the warm one. (This used to
        // return 0 here, which silently waived the quota after each restart.)
        try {
            const res = await runQuery(
                `SELECT db_size FROM ${metaTable} WHERE id = $1 AND user_id = $2`,
                [id, ownerId]
            );
            const n = Number(res?.rows?.[0]?.db_size);
            return Number.isFinite(n) && n > 0 ? n : 0;
        } catch (_) { return 0; }
    }

    /**
     * Wipe the DB entirely — close the handle, delete the local file and the
     * RustFS object, and zero the Postgres metadata.
     */
    async function reset(ownerId, id) {
        const entry = handles.get(id);
        if (entry) {
            if (entry.ownerId !== ownerId) {
                throw new Error(`${entityLabel} handle owned by another user — refusing to reset`);
            }
            if (entry.flushTimer) clearTimeout(entry.flushTimer);
            try { entry.db.close(); } catch (_) {}
            handles.delete(id);
        }
        try { await fsp.unlink(localPathFor(id)); } catch (_) {}
        if (storage.isAvailable()) {
            try { await storage.deleteFile(dbKey(ownerId, id)); } catch (_) {}
        }
        await runQuery(
            `UPDATE ${metaTable} SET db_sha256 = '', db_size = 0, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
            [id, ownerId]
        );
    }

    /**
     * Force any pending writes to RustFS and close out the debounce. Used
     * before version snapshotting so the snapshot includes everything the
     * user's done.
     */
    async function flush(ownerId, id) {
        const entry = handles.get(id);
        if (!entry) return;
        if (entry.ownerId !== ownerId) {
            throw new Error(`${entityLabel} handle owned by another user — refusing to flush`);
        }
        if (entry.flushTimer) {
            clearTimeout(entry.flushTimer);
            entry.flushTimer = null;
        }
        // Loop: a write that lands during an in-flight flush re-marks dirty,
        // and we want flush() to only return once everything's actually on
        // RustFS.
        while (entry.dirty || entry.flushing) {
            await flushNow(id);
        }
    }

    /**
     * Drop the cached handle + local file without touching RustFS. Used after
     * a version restore overwrites the RustFS object out-of-band so the next
     * access re-downloads the restored bytes. Intentionally takes no ownerId
     * (no trust check) — it only discards local state.
     */
    async function invalidate(id) {
        const entry = handles.get(id);
        if (entry) {
            if (entry.flushTimer) clearTimeout(entry.flushTimer);
            // If a flush is in flight, let it finish so we don't tear it down
            // mid-upload — but we'll still drop the handle afterward.
            if (entry.flushing) {
                try { await entry.flushing; } catch (_) {}
            }
            try { entry.db.close(); } catch (_) {}
            handles.delete(id);
        }
        try { await fsp.unlink(localPathFor(id)); } catch (_) {}
    }

    /**
     * Flush all dirty handles and close everything. Wired to SIGINT/SIGTERM so
     * we don't lose recent writes on a graceful shutdown.
     */
    async function closeAll() {
        const ids = [...handles.keys()];
        for (const id of ids) {
            const entry = handles.get(id);
            if (!entry) continue;
            try {
                if (entry.flushTimer) clearTimeout(entry.flushTimer);
                if (entry.dirty && !entry.poisoned) await flushNow(id);
            } catch (e) {
                log.warn(`[${logPrefix}] Shutdown flush failed for ${id}:`, e.message);
            }
            try { entry.db.close(); } catch (_) {}
            handles.delete(id);
        }
    }

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
