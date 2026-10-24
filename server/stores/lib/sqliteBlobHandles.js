// @typecheck
'use strict';

/**
 * The load half of the SQLite-blob engine (./sqliteBlobEngine.js): serve a
 * cached handle to its owner, or download the blob and open it, coalescing
 * concurrent cold opens. Shares the engine's handle Map.
 */

const fsp = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * @param {any} deps  handles (the engine's Map), maybeEvict (from the
 *                       flusher), dbKey, workDir, storage, runQuery, metaTable,
 *                       entityLabel, assertServable — see createSqliteBlobEngine.
 */
function createHandleLoader({ handles, maybeEvict, dbKey, workDir, storage, runQuery, metaTable, entityLabel, assertServable }) {
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
            try { await fsp.unlink(localPath + ext); } catch (_) { bestEffort('stores/lib/sqliteBlobHandles:openCold', _); /* local file absent */ }
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
        } catch (_) { log.warn('persisted sha lookup failed, treating it as unknown', _); }

        const db = new Database(localPath);
        // DELETE journaling keeps everything in a single .db file at rest — no
        // sidecar files to track between request lifetimes. This is strictly
        // single-process per entity (the handle Map enforces it), so we don't
        // need WAL's concurrent-reader benefit.
        try { db.pragma('journal_mode = DELETE'); } catch (_) { log.warn('could not set journal_mode', _); }
        try { db.pragma('foreign_keys = ON'); } catch (_) { log.warn('could not enable foreign_keys', _); }

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

    return { getHandle, localPathFor };
}

module.exports = { createHandleLoader };
