// @typecheck strict
'use strict';
/**
 * The update log of the co-editing store (../collabDocStore.js): appending
 * an update under the document row lock, reading the log and the state,
 * and compaction (checkpoints, folding the log).
 */

const { FENCE_TTL_MS } = require('../collabDocLeases');
const { ORIGINS, LIST_MAX, LOAD_RETRIES, CollabStoreError, toInt, rowToDoc, rowToUpdate, DOC_COLUMNS } = require('./collabDocRows');

/** @typedef {import('./collabDocRows').Q} Q */
/** @typedef {import('./collabDocRows').ClientClock} ClientClock */

/** @param {Q} q @param {string} docId @param {ClientClock} c @param {string|null} userId @param {string} origin */
async function bindClient(q, docId, c, userId, origin) {
    await q.query(
        `INSERT INTO collab_doc_clients (doc_id, client_id, user_id, origin, max_clock)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (doc_id, client_id) DO UPDATE
            SET max_clock = GREATEST(collab_doc_clients.max_clock, EXCLUDED.max_clock)`,
        [docId, c.clientId, userId, origin, c.to],
    );
}

/**
 * Append one update under the document row lock.
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeUpdateAppend(db, ready) {
    /**
     * Append one update under the document row lock.
     *
     * Refusals (CollabStoreError): NOT_FOUND (no such document in this
     * project), DOC_CLOSING (being folded back into its resource: see
     * `fence`), DOC_TOO_LARGE (the stored state would pass `maxStateBytes`,
     * or the measured content `maxContentBytes`), CONTENT_UNMEASURED (the
     * content may pass `maxContentBytes`: measure it and append again with
     * `measured`), CLIENT_ID_CONFLICT (new structs under a client id another
     * author owns). Nothing is written on a refusal.
     *
     * The content cap is the resource owner's own (a page body's byte cap):
     * the rendered size at the last measurement plus the bytes appended
     * since is the estimate; only past the cap does the caller render.
     *
     * @param {{ docId: string, projectId: string, userId: string|null, origin?: string, agentId?: string|null,
     *           byteLen: number, clients: ClientClock[], declaredClientId?: number|null,
     *           seal: (seq: number) => Buffer, maxStateBytes: number,
     *           maxContentBytes?: number|null, measured?: { bytes: number, atSeq: number }|null }} p
     * @returns {Promise<{ seq: number }>}
     */
    async function appendUpdate(p) {
        await ready();
        const { docId, projectId, userId, origin = 'user', agentId = null, byteLen, clients, declaredClientId = null, seal, maxStateBytes } = p;
        const maxContentBytes = p.maxContentBytes || null;
        const measured = p.measured || null;
        if (!ORIGINS.includes(origin)) throw new CollabStoreError('INVALID_ORIGIN', `origin must be one of ${ORIGINS.join(', ')}`);
        return db.tx(async (q) => {
            const doc = (await q.query(
                `SELECT id, update_seq, state_bytes, pending_bytes, content_bytes, unmeasured_bytes,
                        (closing_at IS NOT NULL AND closing_at > NOW() - ($3::int * INTERVAL '1 millisecond')) AS closing
                   FROM collab_docs WHERE id = $1 AND project_id = $2 FOR UPDATE`,
                [docId, projectId, FENCE_TTL_MS],
            )).rows[0];
            if (!doc) throw new CollabStoreError('NOT_FOUND', 'Document not found');
            if (doc.closing) throw new CollabStoreError('DOC_CLOSING', 'The document is being folded back into its item');
            if (toInt(doc.state_bytes) + toInt(doc.pending_bytes) + byteLen > maxStateBytes
                || (maxContentBytes && measured && measured.bytes > maxContentBytes)) {
                throw new CollabStoreError('DOC_TOO_LARGE', 'This document has reached its size limit');
            }
            if (maxContentBytes && !measured && toInt(doc.content_bytes) + toInt(doc.unmeasured_bytes) + byteLen > maxContentBytes) {
                throw new CollabStoreError('CONTENT_UNMEASURED', 'The content may pass its size limit; measure it first');
            }

            const wanted = new Map(clients.map((c) => [c.clientId, c]));
            if (declaredClientId !== null && declaredClientId !== undefined && !wanted.has(declaredClientId)) {
                wanted.set(declaredClientId, { clientId: declaredClientId, to: 0 });
            }
            if (wanted.size) {
                const bound = (await q.query(
                    'SELECT client_id, user_id, origin, max_clock FROM collab_doc_clients WHERE doc_id = $1 AND client_id = ANY($2::bigint[])',
                    [docId, [...wanted.keys()]],
                )).rows;
                for (const b of bound) {
                    const c = wanted.get(toInt(b.client_id));
                    if (!c) continue;
                    const mine = (b.user_id || null) === (userId || null) && b.origin === origin;
                    if (mine) continue;
                    // Structs this id already stored are a re-send, not a write.
                    if (c.to > 0 && c.to <= toInt(b.max_clock)) { wanted.delete(c.clientId); continue; }
                    throw new CollabStoreError('CLIENT_ID_CONFLICT', 'This editing session id belongs to someone else');
                }
            }

            // A measurement covers the state it was taken of plus this
            // update; what others appended after that state stays unmeasured.
            const next = (await q.query(
                `UPDATE collab_docs
                    SET update_seq = update_seq + 1, pending_count = pending_count + 1,
                        pending_bytes = pending_bytes + $2, last_edit_at = NOW(),
                        content_bytes = CASE WHEN $3::bigint IS NULL THEN content_bytes ELSE $3::bigint END,
                        unmeasured_bytes = CASE WHEN $3::bigint IS NULL THEN unmeasured_bytes + $2
                            ELSE (SELECT COALESCE(SUM(byte_len), 0) FROM collab_doc_updates WHERE doc_id = $1 AND seq > $4) END,
                        session_started_at = COALESCE(session_started_at, NOW()), work_after = NULL, updated_at = NOW()
                  WHERE id = $1
                  RETURNING update_seq`,
                [docId, byteLen, measured ? Math.floor(measured.bytes) : null, measured ? measured.atSeq : 0],
            )).rows[0];
            const seq = toInt(next.update_seq);
            await q.query(
                `INSERT INTO collab_doc_updates (doc_id, seq, body, byte_len, user_id, origin, agent_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [docId, seq, seal(seq), byteLen, userId, origin, agentId],
            );
            for (const c of wanted.values()) await bindClient(q, docId, c, userId, origin);
            return { seq };
        });
    }

    return { appendUpdate };
}

/**
 * Read the update log, and the whole state with retries.
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeUpdateReads(db, ready) {
    /**
     * Updates after `afterSeq`, oldest first, at most `limit`.
     * @param {string} docId @param {number} afterSeq @param {number} [limit]
     */
    async function listUpdates(docId, afterSeq, limit = 200) {
        await ready();
        const n = Math.min(Math.max(Number(limit) || 1, 1), LIST_MAX);
        const r = await db.query(
            `SELECT seq, body, byte_len, user_id, origin, agent_id, created_at
               FROM collab_doc_updates WHERE doc_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
            [docId, afterSeq, n],
        );
        return r.rows.map(rowToUpdate);
    }

    /**
     * Everything needed to rebuild the current state: the document row with
     * its snapshot, and every update after the snapshot up to the head read
     * with it. A compaction that runs between the two reads can delete rows
     * the old snapshot does not cover; the contiguity check notices the hole
     * and reads again, so a caller never builds a state with a gap in it.
     *
     * @param {string} docId
     * @param {{ withCheckpoint?: boolean }} [opts]
     */
    async function loadState(docId, { withCheckpoint = false } = {}) {
        await ready();
        for (let attempt = 0; attempt < LOAD_RETRIES; attempt += 1) {
            const docRow = (await db.query(
                `SELECT ${DOC_COLUMNS}, snapshot${withCheckpoint ? ', checkpoint_snapshot' : ''} FROM collab_docs WHERE id = $1`,
                [docId],
            )).rows[0];
            if (!docRow) return null;
            const doc = /** @type {NonNullable<ReturnType<typeof rowToDoc>>} */ (rowToDoc(docRow));
            const rows = (await db.query(
                `SELECT seq, body, byte_len, user_id, origin, agent_id, created_at
                   FROM collab_doc_updates WHERE doc_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq ASC`,
                [docId, doc.snapshotSeq, doc.updateSeq],
            )).rows.map(rowToUpdate);
            const contiguous = rows.length === doc.updateSeq - doc.snapshotSeq
                && rows.every((u, i) => u.seq === doc.snapshotSeq + 1 + i);
            if (contiguous) return { doc, updates: rows };
        }
        throw new CollabStoreError('STATE_MOVING', 'The document changed too often while it was being read');
    }

    return { listUpdates, loadState };
}

/**
 * Fold the log into a snapshot, record checkpoints, and who wrote a range.
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeCompaction(db, ready) {
    /**
     * Fold the log into a new snapshot, compare-and-set on the snapshot seq so
     * two compactions can never overwrite each other with an older state.
     * Rows up to `deleteUpTo` older than `graceMs` are removed; `retained_from`
     * follows the lowest row left.
     *
     * @param {{ docId: string, expectedSnapshotSeq: number, uptoSeq: number, snapshot: Buffer,
     *           stateBytes: number, deleteUpTo: number, graceMs: number }} p
     * @returns {Promise<boolean>} false when another compaction got there first
     */
    async function compact({ docId, expectedSnapshotSeq, uptoSeq, snapshot, stateBytes, deleteUpTo, graceMs }) {
        await ready();
        return db.tx(async (q) => {
            const cur = (await q.query('SELECT snapshot_seq, update_seq FROM collab_docs WHERE id = $1 FOR UPDATE', [docId])).rows[0];
            if (!cur || toInt(cur.snapshot_seq) !== expectedSnapshotSeq || uptoSeq <= expectedSnapshotSeq) return false;
            await q.query(
                `DELETE FROM collab_doc_updates
                  WHERE doc_id = $1 AND seq <= $2 AND created_at < NOW() - ($3::int * INTERVAL '1 millisecond')`,
                [docId, Math.min(deleteUpTo, uptoSeq), Math.max(0, Math.floor(graceMs))],
            );
            const left = (await q.query(
                `SELECT MIN(seq) AS lowest,
                        COUNT(*) FILTER (WHERE seq > $2)::int AS pending,
                        COALESCE(SUM(byte_len) FILTER (WHERE seq > $2), 0)::bigint AS pending_bytes
                   FROM collab_doc_updates WHERE doc_id = $1`,
                [docId, uptoSeq],
            )).rows[0];
            const retainedFrom = left.lowest === null || left.lowest === undefined ? uptoSeq + 1 : toInt(left.lowest);
            await q.query(
                `UPDATE collab_docs
                    SET snapshot = $2, snapshot_seq = $3, state_bytes = $4, retained_from = $5,
                        pending_count = $6, pending_bytes = $7, updated_at = NOW()
                  WHERE id = $1`,
                [docId, snapshot, uptoSeq, stateBytes, retainedFrom, toInt(left.pending), toInt(left.pending_bytes)],
            );
            return true;
        });
    }

    /**
     * A version was written for everything up to `seq`: move the checkpoint,
     * keep its state for the next version's stats, and close the editing
     * session unless more arrived meanwhile.
     *
     * @param {string} docId @param {{ seq: number, snapshot: Buffer|null }} p
     */
    async function recordCheckpoint(docId, { seq, snapshot }) {
        await ready();
        await db.query(
            `UPDATE collab_docs
                SET checkpoint_seq = GREATEST(checkpoint_seq, $2),
                    checkpoint_snapshot = CASE WHEN $2 >= checkpoint_seq THEN $3 ELSE checkpoint_snapshot END,
                    checkpoint_at = NOW(),
                    session_started_at = CASE WHEN update_seq > $2 THEN session_started_at ELSE NULL END,
                    updated_at = NOW()
              WHERE id = $1`,
            [docId, seq, snapshot],
        );
    }

    /**
     * Who wrote between two seqs (exclusive, inclusive): one row per distinct
     * author, origin and agent. Server-attested; nothing here came from the
     * document itself.
     *
     * @param {string} docId @param {number} afterSeq @param {number} uptoSeq
     * @returns {Promise<Array<{ userId: string|null, origin: string, agentId: string|null }>>}
     */
    async function authorsBetween(docId, afterSeq, uptoSeq) {
        await ready();
        const r = await db.query(
            `SELECT user_id, origin, agent_id, MIN(seq) AS first_seq
               FROM collab_doc_updates WHERE doc_id = $1 AND seq > $2 AND seq <= $3
              GROUP BY user_id, origin, agent_id
              ORDER BY first_seq ASC`,
            [docId, afterSeq, uptoSeq],
        );
        return r.rows.map((row) => ({ userId: row.user_id || null, origin: row.origin, agentId: row.agent_id || null }));
    }

    return { compact, recordCheckpoint, authorsBetween };
}

module.exports = { bindClient, makeUpdateAppend, makeUpdateReads, makeCompaction };
