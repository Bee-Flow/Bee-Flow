// @typecheck
'use strict';

/**
 * The write-back half of the SQLite-blob engine (./sqliteBlobEngine.js): the
 * debounced flush, the sha-gated upload to RustFS and LRU eviction (which
 * flushes before it closes). Shares the engine's handle Map.
 */

const fsp = require('fs/promises');
const crypto = require('crypto');
const log = require('../../telemetry/log');

const FLUSH_DEBOUNCE_MS = 5000;
const MAX_OPEN_HANDLES = 32;

/**
 * @param {object} deps  handles (the engine's Map), dbKey, storage, runQuery,
 *                       metaTable, logPrefix, entityLabel — see createSqliteBlobEngine.
 */
function createFlusher({ handles, dbKey, storage, runQuery, metaTable, logPrefix, entityLabel }) {
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

    return { scheduleFlush, flushNow, maybeEvict };
}

module.exports = { createFlusher, FLUSH_DEBOUNCE_MS, MAX_OPEN_HANDLES };
