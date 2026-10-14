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
const { makeCollabDocLeases } = require('./collabDocLeases');
const log = require('../telemetry/log');

const {
    RESOURCE_KINDS, CONFIG_KEY_PREFIX, ORIGINS, CollabStoreError, rowToDoc,
} = require('./lib/collabDocRows');
const { makeUpdateAppend, makeUpdateReads, makeCompaction } = require('./lib/collabDocUpdates');
const { makeDocAccess, makeDocListing, makeDocUpkeep } = require('./lib/collabDocDocs');

/** @typedef {import('./lib/collabDocRows').Q} Q */

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

/**
 * @param {Q & { tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T> }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeCollabDocStore(db, { ready = async () => {} } = {}) {
    const leases = makeCollabDocLeases(db, { ready });
    // One factory per concern (stores/lib/collabDoc*.js), all over the same db
    // and ready; the store is their union, in the order it always listed.
    const { ensureDoc, getDoc, findDoc, getDocByResource, seedOnce } = makeDocAccess(db, ready);
    const { appendUpdate } = makeUpdateAppend(db, ready);
    const { listUpdates, loadState } = makeUpdateReads(db, ready);
    const { compact, recordCheckpoint, authorsBetween } = makeCompaction(db, ready);
    const { listWork, listByResource, listByProject, listByOrg } = makeDocListing(db, ready);
    const { clientBinding, deleteDoc, anonymiseUser } = makeDocUpkeep(db, ready);

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
