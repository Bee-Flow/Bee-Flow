// @typecheck
/**
 * The short-lived claims on a co-edited document (collab_docs), next to the
 * store that owns the table (stores/collabDocStore.js spreads them into its
 * own API):
 *
 *   mirror lease   one writer of the resource mirror at a time
 *                  (claimMirror / releaseMirror)
 *   fence          no appends while the document is folded back into its
 *                  resource (fence / unfence; appendUpdate refuses DOC_CLOSING)
 *   work back-off  a document the upkeep job could not finish stays off its
 *                  work list for a while (deferWork; an append lifts it)
 *
 * None of them holds a database transaction open while the caller works, so a
 * slow owner hook never pins a pool connection or blocks typing; each expires
 * on its own when the process that took it dies.
 */

'use strict';

// A fold-back fence older than this is left over from a process that died
// mid-way: appends go through again.
const FENCE_TTL_MS = 2 * 60_000;
// The mirror lease of a writer that died is free again after this. A live
// writer is done well within it: its two statements are each cut off at the
// pool's 30 s statement timeout.
const MIRROR_LEASE_MS = 60_000;

const toInt = (/** @type {any} */ v) => (v === null || v === undefined ? 0 : Number(v));

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeCollabDocLeases(db, { ready = async () => {} } = {}) {
    /**
     * Take the document's mirror lease: one writer of the resource mirror at
     * a time, so an older state can never overwrite a newer one while
     * `materialized_seq` claims the newer is there. Answers the current
     * `materializedSeq` under the lease, `{busy: true}` while another writer
     * holds it (the lease of a writer that died frees itself after a while),
     * or null when the document is gone.
     * @param {string} docId @param {string} token
     * @returns {Promise<{ materializedSeq: number, busy?: undefined } | { busy: true } | null>}
     */
    async function claimMirror(docId, token) {
        await ready();
        const r = await db.query(
            `UPDATE collab_docs SET mirror_lease = $2, mirror_lease_until = NOW() + ($3::int * INTERVAL '1 millisecond')
              WHERE id = $1 AND (mirror_lease IS NULL OR mirror_lease_until < NOW())
              RETURNING materialized_seq`,
            [docId, token, MIRROR_LEASE_MS],
        );
        if (r.rows[0]) return { materializedSeq: toInt(r.rows[0].materialized_seq) };
        const exists = await db.query('SELECT 1 FROM collab_docs WHERE id = $1', [docId]);
        return exists.rows.length ? { busy: true } : null;
    }

    /**
     * Give the lease back; `written` records what the mirror now holds: its
     * seq (never moving back) and its rendered size, with everything
     * appended after that seq as not yet measured.
     * @param {string} docId @param {string} token @param {{ seq: number, contentBytes: number }|null} written
     */
    async function releaseMirror(docId, token, written) {
        await ready();
        if (!written) {
            await db.query('UPDATE collab_docs SET mirror_lease = NULL, mirror_lease_until = NULL WHERE id = $1 AND mirror_lease = $2', [docId, token]);
            return;
        }
        await db.query(
            `UPDATE collab_docs
                SET materialized_seq = GREATEST(materialized_seq, $3), materialized_at = NOW(),
                    content_bytes = $4,
                    unmeasured_bytes = (SELECT COALESCE(SUM(byte_len), 0) FROM collab_doc_updates WHERE doc_id = $1 AND seq > $3),
                    mirror_lease = NULL, mirror_lease_until = NULL, updated_at = NOW()
              WHERE id = $1 AND mirror_lease = $2`,
            [docId, token, written.seq, Math.max(0, Math.floor(written.contentBytes || 0))],
        );
    }

    /**
     * Fence a document before it is folded back into its resource: appends
     * are refused (DOC_CLOSING) from here on, and the UPDATE waits for the
     * row lock, so every append that was acknowledged is committed — and in
     * the state the fold-back reads — before this returns. False when the
     * document is gone.
     * @param {string} docId
     */
    async function fence(docId) {
        await ready();
        const r = await db.query('UPDATE collab_docs SET closing_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING id', [docId]);
        return r.rows.length > 0;
    }

    /** The fold-back did not happen: appends go through again. @param {string} docId */
    async function unfence(docId) {
        await ready();
        await db.query('UPDATE collab_docs SET closing_at = NULL, updated_at = NOW() WHERE id = $1', [docId]);
    }

    /**
     * Keep a document the job could not finish off the work list for a
     * while, so it cannot crowd out the rest; an edit lifts it sooner.
     * @param {string} docId @param {number} ms
     */
    async function deferWork(docId, ms) {
        await ready();
        await db.query(
            "UPDATE collab_docs SET work_after = NOW() + ($2::int * INTERVAL '1 millisecond') WHERE id = $1",
            [docId, Math.max(0, Math.floor(ms))],
        );
    }

    return { claimMirror, releaseMirror, fence, unfence, deferWork };
}

module.exports = { makeCollabDocLeases, FENCE_TTL_MS, MIRROR_LEASE_MS };
