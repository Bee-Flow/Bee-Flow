// @typecheck strict
'use strict';
/**
 * The document rows of the co-editing store (../collabDocStore.js): opening
 * and finding a document, seeding it once from legacy content, the upkeep
 * job's work list and the listings, and removal and anonymisation.
 */

const { FENCE_TTL_MS } = require('../collabDocLeases');
const { RESOURCE_KINDS, LIST_MAX, LIST_WORK_THRESHOLDS, CollabStoreError, toInt, rowToDoc, DOC_COLUMNS } = require('./collabDocRows');
const { bindClient } = require('./collabDocUpdates');

/** @typedef {import('./collabDocRows').Q} Q */
/** @typedef {import('./collabDocRows').ClientClock} ClientClock */

/**
 * Open, find and seed a document.
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeDocAccess(db, ready) {
    /**
     * Open or create the document for a resource field. Idempotent through
     * the unique index: two members opening at once get the same row.
     *
     * @param {{ id: string, projectId: string, kind: string, resourceId: string, field?: string, createdBy?: string|null }} p
     * @returns {Promise<{ doc: NonNullable<ReturnType<typeof rowToDoc>>, created: boolean }>}
     */
    async function ensureDoc({ id, projectId, kind, resourceId, field = 'body', createdBy = null }) {
        await ready();
        if (!RESOURCE_KINDS.includes(kind)) throw new CollabStoreError('INVALID_KIND', `kind must be one of ${RESOURCE_KINDS.join(', ')}`);
        const inserted = await db.query(
            `INSERT INTO collab_docs (id, project_id, resource_kind, resource_id, field, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (resource_kind, resource_id, field) DO NOTHING
             RETURNING ${DOC_COLUMNS}`,
            [id, projectId, kind, resourceId, field, createdBy],
        );
        if (inserted.rows[0]) return { doc: /** @type {NonNullable<ReturnType<typeof rowToDoc>>} */ (rowToDoc(inserted.rows[0])), created: true };
        const existing = await getDocByResource(kind, resourceId, field);
        if (!existing) throw new CollabStoreError('RACE', 'The document disappeared while it was being opened');
        return { doc: existing, created: false };
    }

    /** @param {string} docId */
    async function getDoc(docId) {
        await ready();
        const r = await db.query(`SELECT ${DOC_COLUMNS} FROM collab_docs WHERE id = $1`, [docId]);
        return rowToDoc(r.rows[0] || null);
    }

    /** One document, only through the project it belongs to. @param {string} projectId @param {string} docId */
    async function findDoc(projectId, docId) {
        await ready();
        const r = await db.query(`SELECT ${DOC_COLUMNS} FROM collab_docs WHERE id = $1 AND project_id = $2`, [docId, projectId]);
        return rowToDoc(r.rows[0] || null);
    }

    /** @param {string} kind @param {string} resourceId @param {string} [field] */
    async function getDocByResource(kind, resourceId, field = 'body') {
        await ready();
        const r = await db.query(
            `SELECT ${DOC_COLUMNS} FROM collab_docs WHERE resource_kind = $1 AND resource_id = $2 AND field = $3`,
            [kind, resourceId, field],
        );
        return rowToDoc(r.rows[0] || null);
    }

    /**
     * Seed a new document from its legacy content, exactly once, under the
     * document row lock. `build` runs inside the lock and answers null for
     * "nothing to import" (an empty document is still marked seeded), or the
     * import as one update: its plaintext size, the client ids it carries,
     * and `seal(seq)` / `sealCheckpoint(seq)` producing the stored frames.
     *
     * Two members opening a never-seeded document at the same instant are
     * serialised here, and the second finds `seeded_at` set: without this the
     * whole document would be imported twice and appear duplicated.
     *
     * @param {string} docId
     * @param {() => Promise<null | { byteLen: number, clients: ClientClock[], seal: (seq: number) => Buffer, sealCheckpoint?: (seq: number) => Buffer,
 *                                contentBytes?: number }>} build
     * @returns {Promise<{ seeded: boolean, seq: number }>}
     */
    async function seedOnce(docId, build) {
        await ready();
        return db.tx(async (q) => {
            const row = (await q.query('SELECT id, update_seq, seeded_at FROM collab_docs WHERE id = $1 FOR UPDATE', [docId])).rows[0];
            if (!row) throw new CollabStoreError('NOT_FOUND', 'Document not found');
            if (row.seeded_at) return { seeded: false, seq: toInt(row.update_seq) };
            const seed = await build();
            if (!seed) {
                await q.query('UPDATE collab_docs SET seeded_at = NOW(), updated_at = NOW() WHERE id = $1', [docId]);
                return { seeded: true, seq: toInt(row.update_seq) };
            }
            const seq = toInt(row.update_seq) + 1;
            const checkpoint = typeof seed.sealCheckpoint === 'function' ? seed.sealCheckpoint(seq) : null;
            // The import is where the mirror, the last checkpoint and the
            // feed already are: nobody edited anything, so nothing may be
            // re-materialised, versioned or announced because of it.
            await q.query(
                `UPDATE collab_docs
                    SET update_seq = $2, pending_count = pending_count + 1, pending_bytes = pending_bytes + $3,
                        materialized_seq = $2, materialized_at = NOW(), content_bytes = $5, unmeasured_bytes = 0,
                        checkpoint_seq = $2, checkpoint_snapshot = $4, checkpoint_at = NOW(),
                        seeded_at = NOW(), updated_at = NOW()
                  WHERE id = $1`,
                [docId, seq, seed.byteLen, checkpoint, Math.max(0, Math.floor(Number(seed.contentBytes) || 0))],
            );
            await q.query(
                `INSERT INTO collab_doc_updates (doc_id, seq, body, byte_len, user_id, origin)
                 VALUES ($1, $2, $3, $4, NULL, 'import')`,
                [docId, seq, seed.seal(seq), seed.byteLen],
            );
            for (const c of seed.clients) await bindClient(q, docId, c, null, 'import');
            return { seeded: true, seq };
        });
    }

    return { ensureDoc, getDoc, findDoc, getDocByResource, seedOnce };
}

/**
 * The upkeep work list, and the listings by resource, project and organisation.
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeDocListing(db, ready) {
    /**
     * Documents with work for the compaction job. Thresholds in milliseconds
     * and bytes, named as core/collab/limits.js names them; see
     * jobs/collabDocCompaction.js for what each one means. A missing
     * threshold throws: in SQL it would be NULL, and a NULL comparison
     * silently selects nothing. Documents being folded back, or put off
     * after a failure (`deferWork`), are left out.
     *
     * @param {{ compactCount: number, compactBytes: number, sessionIdleMs: number, materialiseIdleMs: number,
     *           materialiseMaxLagMs: number, sessionMaxMs: number, limit?: number }} t
     */
    async function listWork(t) {
        await ready();
        for (const k of LIST_WORK_THRESHOLDS) {
            if (!Number.isFinite(t && t[k])) throw new TypeError(`[CollabDocStore] listWork needs a numeric ${k}`);
        }
        const r = await db.query(
            `SELECT ${DOC_COLUMNS} FROM collab_docs
              WHERE ((pending_count > 0
                     AND (pending_count > $1 OR pending_bytes > $2
                          OR COALESCE(last_edit_at, created_at) < NOW() - ($3::int * INTERVAL '1 millisecond')))
                 OR (materialized_seq < update_seq
                     AND (last_edit_at < NOW() - ($4::int * INTERVAL '1 millisecond')
                          OR materialized_at IS NULL
                          OR materialized_at < NOW() - ($5::int * INTERVAL '1 millisecond')))
                 OR (checkpoint_seq < update_seq
                     AND (last_edit_at < NOW() - ($3::int * INTERVAL '1 millisecond')
                          OR session_started_at < NOW() - ($6::int * INTERVAL '1 millisecond'))))
                AND (work_after IS NULL OR work_after <= NOW())
                AND (closing_at IS NULL OR closing_at < NOW() - ($8::int * INTERVAL '1 millisecond'))
              ORDER BY last_edit_at ASC NULLS FIRST, id ASC
              LIMIT $7`,
            [t.compactCount, t.compactBytes, t.sessionIdleMs, t.materialiseIdleMs, t.materialiseMaxLagMs, t.sessionMaxMs,
                Math.min(Math.max(t.limit || 50, 1), LIST_MAX), FENCE_TTL_MS],
        );
        return r.rows.map((row) => /** @type {NonNullable<ReturnType<typeof rowToDoc>>} */ (rowToDoc(row)));
    }

    /** Every document of a resource (one per field). @param {string} kind @param {string} resourceId */
    async function listByResource(kind, resourceId) {
        await ready();
        const r = await db.query(`SELECT ${DOC_COLUMNS} FROM collab_docs WHERE resource_kind = $1 AND resource_id = $2`, [kind, resourceId]);
        return r.rows.map((row) => /** @type {NonNullable<ReturnType<typeof rowToDoc>>} */ (rowToDoc(row)));
    }

    /** Every document of one project (it is about to be deleted). @param {string} projectId */
    async function listByProject(projectId) {
        await ready();
        const r = await db.query(
            `SELECT ${DOC_COLUMNS} FROM collab_docs WHERE project_id = $1 ORDER BY id ASC LIMIT $2`,
            [projectId, LIST_MAX],
        );
        return r.rows.map((row) => /** @type {NonNullable<ReturnType<typeof rowToDoc>>} */ (rowToDoc(row)));
    }

    /**
     * The documents in an organisation's projects, one page (by id) after
     * `afterId`. `orgId` and `fallback` are already resolved (auth's org-less
     * sentinel for projects with no organisation), so this store needs no
     * knowledge of that rule.
     * @param {string} orgId @param {string} fallback @param {{ afterId?: string, limit?: number }} [page]
     */
    async function listByOrg(orgId, fallback, { afterId = '', limit = LIST_MAX } = {}) {
        await ready();
        const r = await db.query(
            `SELECT ${DOC_COLUMNS.split(',').map((c) => `cd.${c.trim()}`).join(', ')}
               FROM collab_docs cd JOIN projects p ON p.id = cd.project_id
              WHERE COALESCE(NULLIF(p.organization_id, ''), $2) = $1 AND cd.id > $4
              ORDER BY cd.id ASC
              LIMIT $3`,
            [orgId, fallback, Math.min(Math.max(Number(limit) || 1, 1), LIST_MAX), afterId || ''],
        );
        return r.rows.map((row) => /** @type {NonNullable<ReturnType<typeof rowToDoc>>} */ (rowToDoc(row)));
    }

    return { listWork, listByResource, listByProject, listByOrg };
}

/**
 * Who owns a client id, deleting a document, anonymising a user.
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeDocUpkeep(db, ready) {
    /** Who owns a client id in this document, or null. @param {string} docId @param {number} clientId */
    async function clientBinding(docId, clientId) {
        await ready();
        const r = await db.query('SELECT user_id, origin, max_clock FROM collab_doc_clients WHERE doc_id = $1 AND client_id = $2', [docId, clientId]);
        const row = r.rows[0];
        return row ? { userId: row.user_id || null, origin: row.origin, maxClock: toInt(row.max_clock) } : null;
    }

    /**
     * Delete a document; its log and bindings cascade. With `uptoSeq`, only
     * while nothing was appended after it (the state that was folded back),
     * so an update the fold-back never saw is never deleted with it.
     * @param {string} docId @param {{ uptoSeq?: number|null }} [opts]
     */
    async function deleteDoc(docId, { uptoSeq = null } = {}) {
        await ready();
        const r = uptoSeq === null || uptoSeq === undefined
            ? await db.query('DELETE FROM collab_docs WHERE id = $1 RETURNING id', [docId])
            : await db.query('DELETE FROM collab_docs WHERE id = $1 AND update_seq <= $2 RETURNING id', [docId, uptoSeq]);
        return r.rows.length > 0;
    }

    /**
     * Erasure: the person's id leaves the log and the bindings; the content
     * belongs to the project and stays. Returns how many rows were touched.
     * @param {string} userId
     */
    async function anonymiseUser(userId) {
        await ready();
        return db.tx(async (q) => {
            const updates = await q.query('UPDATE collab_doc_updates SET user_id = NULL WHERE user_id = $1', [userId]);
            const clients = await q.query('UPDATE collab_doc_clients SET user_id = NULL WHERE user_id = $1', [userId]);
            const docs = await q.query('UPDATE collab_docs SET created_by = NULL WHERE created_by = $1', [userId]);
            return { updates: updates.rowCount || 0, clients: clients.rowCount || 0, docs: docs.rowCount || 0 };
        });
    }

    return { clientBinding, deleteDoc, anonymiseUser };
}

module.exports = { makeDocAccess, makeDocListing, makeDocUpkeep };
