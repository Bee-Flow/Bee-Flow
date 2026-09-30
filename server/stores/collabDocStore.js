// @typecheck
/**
 * Real-time co-editing storage: one append-only Yjs update log per document,
 * plus the compacted snapshot the log folds into.
 *
 *   collab_docs          one row per co-edited resource field (a notebook's
 *                        document, a project page's body). Owned by the
 *                        project (FK, cascade), unique per resource.
 *   collab_doc_updates   the update log, `seq` gapless per document
 *   collab_doc_clients   which Yjs client id belongs to which author
 *
 * ── What this store never sees: plaintext ──────────────────────────────────
 *
 * `snapshot`, `checkpoint_snapshot` and every `collab_doc_updates.body` are
 * FRAMED bytes sealed with a key derived from the project key
 * (core/collab/frame.js). The store writes what it is given and hands rows
 * back as stored. Sealing needs the seq for its binding, and the seq is only
 * known inside the transaction that allocates it, so appends take a `seal(seq)`
 * callback instead of a finished body: the key never enters this module, and
 * there is no code path here that could write a plaintext copy.
 *
 * ── Why seq comes from the document row, under its lock ─────────────────────
 *
 * Same rule as project_events and team chats: `update_seq + 1` is taken by an
 * UPDATE on the collab_docs row inside the transaction that inserts the
 * update. Two editors of the same document are serialised on that row for a
 * few milliseconds; nobody else is (the projects row is never touched, so a
 * busy document cannot slow down the rest of its project). A sequence would be
 * unique but not gapless, and a reader that finds a hole must be able to trust
 * that it is a deleted (compacted) range, never an in-flight write.
 *
 * ── Client ids ──────────────────────────────────────────────────────────────
 *
 * A Yjs update names the client id that produced each struct. The first writer
 * to use an id owns it; a later update that adds NEW structs under somebody
 * else's id is refused (CLIENT_ID_CONFLICT), so one member cannot write under
 * another member's name. Re-sending structs the server already holds is
 * harmless and allowed: `max_clock` records how far each id has been stored,
 * and a foreign id whose structs all end at or below it is a duplicate.
 *
 * ── Claims on a document ────────────────────────────────────────────────────
 *
 * The mirror lease, the fold-back fence and the job's back-off live in
 * stores/collabDocLeases.js and are part of this store's API. The content
 * cap: `content_bytes` is the rendered size last measured (at a mirror write
 * or an append that had to be measured), `unmeasured_bytes` what was appended
 * after it; their sum bounds a resource whose owner caps its body.
 *
 * ── Retention ───────────────────────────────────────────────────────────────
 *
 * The compaction job folds the log into `snapshot` and deletes rows it
 * covers, but only rows older than a grace window (a client slightly behind
 * replays instead of re-syncing) and never past the last checkpoint (the rows
 * since then are the contributor list of the next version).
 *
 * Built by a factory over a `{ query, tx }` handle so the pg test runs the
 * store's own SQL against PGlite without module mocking; the default instance
 * wraps the pool.
 */

'use strict';

const { exec, pool, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { makeCollabDocLeases, FENCE_TTL_MS } = require('./collabDocLeases');
const log = require('../telemetry/log');

const RESOURCE_KINDS = Object.freeze(['notebook', 'document']);
/**
 * The configStore key of each organisation's co-editing switch
 * (core/collab/settings.js reads and writes it). Declared here, beside the
 * co-editing tables, so the organisation teardown (a store) can name the key
 * without reaching up into core.
 */
const CONFIG_KEY_PREFIX = 'org_collab_';
const ORIGINS = Object.freeze(['user', 'ai', 'system', 'restore', 'import']);
const LIST_MAX = 500;
const LOAD_RETRIES = 3;
const LIST_WORK_THRESHOLDS = Object.freeze(['compactCount', 'compactBytes', 'sessionIdleMs', 'materialiseIdleMs', 'materialiseMaxLagMs', 'sessionMaxMs']);

/**
 * The schema, idempotent and PGlite-safe. Exported so the pg test creates
 * exactly what production creates.
 */
const DDL = `
    CREATE TABLE IF NOT EXISTS collab_docs (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        resource_kind        TEXT NOT NULL CHECK (resource_kind IN ('notebook', 'document')),
        resource_id          TEXT NOT NULL,
        field                TEXT NOT NULL DEFAULT 'body',
        ywire                TEXT NOT NULL DEFAULT 'y13v1',
        key_scope            TEXT NOT NULL DEFAULT 'project'
                             CHECK (key_scope IN ('none', 'project', 'e2e')),
        update_seq           BIGINT NOT NULL DEFAULT 0,
        snapshot_seq         BIGINT NOT NULL DEFAULT 0,
        snapshot             BYTEA,
        retained_from        BIGINT NOT NULL DEFAULT 1,
        pending_count        INTEGER NOT NULL DEFAULT 0,
        pending_bytes        BIGINT NOT NULL DEFAULT 0,
        state_bytes          BIGINT NOT NULL DEFAULT 0,
        materialized_seq     BIGINT NOT NULL DEFAULT 0,
        materialized_at      TIMESTAMPTZ,
        checkpoint_seq       BIGINT NOT NULL DEFAULT 0,
        checkpoint_snapshot  BYTEA,
        checkpoint_at        TIMESTAMPTZ,
        session_started_at   TIMESTAMPTZ,
        last_edit_at         TIMESTAMPTZ,
        seeded_at            TIMESTAMPTZ,
        created_by           TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Added after the first schema; ADD COLUMN keeps a database that already
    -- has the table in step.
    ALTER TABLE collab_docs ADD COLUMN IF NOT EXISTS closing_at TIMESTAMPTZ;
    ALTER TABLE collab_docs ADD COLUMN IF NOT EXISTS work_after TIMESTAMPTZ;
    ALTER TABLE collab_docs ADD COLUMN IF NOT EXISTS mirror_lease TEXT;
    ALTER TABLE collab_docs ADD COLUMN IF NOT EXISTS mirror_lease_until TIMESTAMPTZ;
    ALTER TABLE collab_docs ADD COLUMN IF NOT EXISTS content_bytes BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE collab_docs ADD COLUMN IF NOT EXISTS unmeasured_bytes BIGINT NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_docs_resource
        ON collab_docs(resource_kind, resource_id, field);
    CREATE INDEX IF NOT EXISTS idx_collab_docs_project ON collab_docs(project_id);
    CREATE INDEX IF NOT EXISTS idx_collab_docs_work
        ON collab_docs(last_edit_at) WHERE update_seq > materialized_seq OR update_seq > checkpoint_seq OR pending_count > 0;

    CREATE TABLE IF NOT EXISTS collab_doc_updates (
        doc_id      TEXT NOT NULL REFERENCES collab_docs(id) ON DELETE CASCADE,
        seq         BIGINT NOT NULL,
        body        BYTEA NOT NULL,
        byte_len    INTEGER NOT NULL,
        user_id     TEXT,
        origin      TEXT NOT NULL DEFAULT 'user'
                    CHECK (origin IN ('user', 'ai', 'system', 'restore', 'import')),
        agent_id    TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (doc_id, seq)
    );

    CREATE TABLE IF NOT EXISTS collab_doc_clients (
        doc_id      TEXT NOT NULL REFERENCES collab_docs(id) ON DELETE CASCADE,
        client_id   BIGINT NOT NULL,
        user_id     TEXT,
        origin      TEXT NOT NULL DEFAULT 'user',
        max_clock   BIGINT NOT NULL DEFAULT 0,
        first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (doc_id, client_id)
    );
`;

/** A refusal the caller turns into a worded 4xx. */
class CollabStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'CollabStoreError';
        this.code = code;
    }
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

/** PGlite answers BYTEA as a Uint8Array, node-postgres as a Buffer. Callers get a Buffer. */
function toBuffer(v) {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return null;
}

/**
 * A document row. Blobs (`snapshot`, `checkpointSnapshot`) are included only
 * when the query selected them, still sealed.
 * @param {any} r
 */
function rowToDoc(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        resourceKind: r.resource_kind,
        resourceId: r.resource_id,
        field: r.field,
        ywire: r.ywire,
        keyScope: r.key_scope,
        updateSeq: toInt(r.update_seq),
        snapshotSeq: toInt(r.snapshot_seq),
        retainedFrom: toInt(r.retained_from),
        pendingCount: toInt(r.pending_count),
        pendingBytes: toInt(r.pending_bytes),
        stateBytes: toInt(r.state_bytes),
        materializedSeq: toInt(r.materialized_seq),
        materializedAt: toIso(r.materialized_at),
        checkpointSeq: toInt(r.checkpoint_seq),
        checkpointAt: toIso(r.checkpoint_at),
        sessionStartedAt: toIso(r.session_started_at),
        lastEditAt: toIso(r.last_edit_at),
        seededAt: toIso(r.seeded_at),
        createdBy: r.created_by || null,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
        ...(r.snapshot !== undefined ? { snapshot: toBuffer(r.snapshot) } : {}),
        ...(r.checkpoint_snapshot !== undefined ? { checkpointSnapshot: toBuffer(r.checkpoint_snapshot) } : {}),
    };
}

/** An update row, `body` still sealed. @param {any} r */
function rowToUpdate(r) {
    return {
        seq: toInt(r.seq),
        body: toBuffer(r.body),
        byteLen: toInt(r.byte_len),
        userId: r.user_id || null,
        origin: r.origin,
        agentId: r.agent_id || null,
        createdAt: toIso(r.created_at),
    };
}

// Every column but the two blobs: most reads need the counters, not megabytes.
const DOC_COLUMNS = `id, project_id, resource_kind, resource_id, field, ywire, key_scope,
    update_seq, snapshot_seq, retained_from, pending_count, pending_bytes, state_bytes,
    materialized_seq, materialized_at, checkpoint_seq, checkpoint_at, session_started_at,
    last_edit_at, seeded_at, created_by, created_at, updated_at`;

/**
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} Q
 * @typedef {{ clientId: number, to: number }} ClientClock  `to` is the exclusive end clock of that client's structs
 */

/**
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeCollabDocStore(db, { ready = async () => {} } = {}) {
    const leases = makeCollabDocLeases(db, { ready });

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
        if (inserted.rows[0]) return { doc: /** @type {any} */ (rowToDoc(inserted.rows[0])), created: true };
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

    return {
        ensureDoc,
        getDoc,
        findDoc,
        getDocByResource,
        seedOnce,
        appendUpdate,
        listUpdates,
        loadState,
        compact,
        // materialized_seq moves only with the mirror lease (releaseMirror),
        // so it always says what the resource row holds.
        ...leases,
        recordCheckpoint,
        authorsBetween,
        listWork,
        clientBinding,
        deleteDoc,
        listByResource,
        listByProject,
        listByOrg,
        anonymiseUser,
    };
}

const initDB = makeStoreInit('CollabDocStore', _initDB);

async function _initDB() {
    // Every store's init starts at once at boot, so the FK target is created
    // first rather than assumed.
    await require('./projectStore').initDB();
    await exec(DDL);
    log.info('[CollabDocStore] PostgreSQL initialized');
}

const defaultStore = makeCollabDocStore({
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => withTransaction((client) => fn({ query: (sql, params) => client.query(sql, params) })),
}, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    RESOURCE_KINDS,
    COLLAB_SETTINGS_KEY_PREFIX: CONFIG_KEY_PREFIX,
    ORIGINS,
    CollabStoreError,
    makeCollabDocStore,
    rowToDoc,
    ...defaultStore,
};
