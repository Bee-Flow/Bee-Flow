// @typecheck
'use strict';

/**
 * Whole-database operations of the SQLite-blob engine (./sqliteBlobEngine.js):
 * size and reset (which reach storage and the metadata row), and flush,
 * invalidate and closeAll (which end a handle's life). Shares the engine's
 * handle Map.
 */

const fsp = require('fs/promises');
const log = require('../../telemetry/log');

/** @param {any} deps  handles, localPathFor, dbKey, storage, runQuery, metaTable, entityLabel. */
function createStorageOps({ handles, localPathFor, dbKey, storage, runQuery, metaTable, entityLabel }) {
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
        } catch (_) { log.debug('no local file, the cold-replica path follows', _); }
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
            try { entry.db.close(); } catch (_) { log.debug('database handle already closed', _); }
            handles.delete(id);
        }
        try { await fsp.unlink(localPathFor(id)); } catch (_) { log.debug('local file already gone', _); }
        if (storage.isAvailable()) {
            try { await storage.deleteFile(dbKey(ownerId, id)); } catch (_) { log.warn('blob could not be deleted from object storage', _); }
        }
        await runQuery(
            `UPDATE ${metaTable} SET db_sha256 = '', db_size = 0, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
            [id, ownerId]
        );
    }

    return { sizeBytes, reset };
}

/** @param {any} deps  handles, localPathFor, flushNow (flusher), logPrefix, entityLabel. */
function createCloseOps({ handles, localPathFor, flushNow, logPrefix, entityLabel }) {
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
                try { await entry.flushing; } catch (_) { log.debug('in-flight flush failed, the handle is dropped anyway', _); }
            }
            try { entry.db.close(); } catch (_) { log.debug('database handle already closed', _); }
            handles.delete(id);
        }
        try { await fsp.unlink(localPathFor(id)); } catch (_) { log.debug('local file already gone', _); }
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
            try { entry.db.close(); } catch (_) { log.debug('database handle already closed', _); }
            handles.delete(id);
        }
    }

    return { flush, invalidate, closeAll };
}

module.exports = { createStorageOps, createCloseOps };
