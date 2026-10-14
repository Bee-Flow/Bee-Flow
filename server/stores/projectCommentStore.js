// @typecheck
/**
 * Comment threads on the pages, notebooks and designed documents filed in a
 * project: people discussing a passage, with the AI answering when asked (or
 * joining by itself, when the thread's `ai_mode` is `auto`).
 *
 * Two tables:
 *
 *   project_comment_threads  one row per thread, owned by the project (FK, cascade)
 *   project_comments         the comments of a thread, `seq` gapless per thread
 *
 * ── What this store never sees: plaintext ──────────────────────────────────
 *
 * `project_comment_threads.anchor` (the quoted passage and its context) and
 * `project_comments.content` hold field envelopes sealed with the PROJECT key
 * (projects/comments/commentCrypto.js). The store writes what it is given and
 * hands rows back as stored; the route seals before a write and opens after a
 * read. There is no code path here that could keep a readable copy. Author
 * ids, mentions (user ids), seq, status and timestamps are plaintext on
 * purpose: they are what the panel, the unread logic and the AI rules are
 * computed from, and they carry no text of the discussion.
 *
 * ── Anchors live outside the content ───────────────────────────────────────
 *
 * A thread points at its passage by a quote selector (quote, prefix, suffix, a
 * block-index hint and, while co-editing, Y relative positions), never by a
 * mark inside the document. A mark would leak into the Markdown, the exports
 * and what the AI reads. The anchor is opaque here: one sealed value, or NULL
 * for a comment on the whole item.
 *
 * ── Why seq comes from the thread row, under its lock ───────────────────────
 *
 * The next number is `last_seq + 1`, read with SELECT … FOR UPDATE inside the
 * transaction that inserts the comment, so two replies at the same instant are
 * serialised on the thread row and the numbers stay gapless (the rule
 * project_events and the team chats follow).
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * A client may send its own id with a new thread (`client_thread_id`, unique
 * per project) or a reply (`client_msg_id`, unique per thread). A retry by the
 * same author answers the row that already exists; the same id from someone
 * else is refused, never answered with their thread or comment.
 *
 * ── Targets ─────────────────────────────────────────────────────────────────
 *
 * `lookupTarget` reads only the id, project and name of the notebook or
 * document a thread is about, so the route can refuse a thread on an item that
 * is not filed in the project without loading the item's body.
 *
 * Built by a factory over a `{ query, tx }` handle so the pg test runs the
 * store's own SQL against PGlite without module mocking; the default instance
 * wraps the pool.
 */

'use strict';

const { exec, pool, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const {
    TARGET_TYPES, THREAD_AI_MODES, THREAD_STATUSES, MAX_COMMENTS_LISTED, MIN_COMMENTS_PER_THREAD,
    MAX_COMMENTS_PER_THREAD, ProjectCommentStoreError, rowToThread, rowToComment,
} = require('./lib/projectCommentRows');
const { makeThreadReads, makeThreadState, makeThreadRemoval } = require('./lib/projectCommentThreads');
const { makeCommentWrites, makeCommentReads } = require('./lib/projectCommentComments');
const { makeCommentErasure } = require('./lib/projectCommentErasure');

/** @typedef {import('./lib/projectCommentRows').Queryable} Queryable */

const DDL = `
    CREATE TABLE IF NOT EXISTS project_comment_threads (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_type       TEXT NOT NULL CHECK (target_type IN ('notebook', 'document', 'task')),
        target_id         TEXT NOT NULL,
        anchor            TEXT,
        status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        ai_mode           TEXT NOT NULL DEFAULT 'mention' CHECK (ai_mode IN ('off', 'mention', 'auto')),
        created_by        TEXT NOT NULL,
        client_thread_id  TEXT,
        resolved_by       TEXT,
        resolved_at       TIMESTAMPTZ,
        comment_count     INTEGER NOT NULL DEFAULT 0,
        last_seq          BIGINT NOT NULL DEFAULT 0,
        last_comment_at   TIMESTAMPTZ,
        auto_paused_until TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_comment_threads_target
        ON project_comment_threads(project_id, target_type, target_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_comment_threads_item
        ON project_comment_threads(target_type, target_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_comment_threads_client
        ON project_comment_threads(project_id, client_thread_id) WHERE client_thread_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS project_comments (
        id             TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL REFERENCES project_comment_threads(id) ON DELETE CASCADE,
        project_id     TEXT NOT NULL,
        seq            BIGINT NOT NULL,
        author_kind    TEXT NOT NULL CHECK (author_kind IN ('user', 'assistant')),
        author_user_id TEXT,
        agent_id       TEXT,
        content        TEXT NOT NULL,
        mentions       JSONB NOT NULL DEFAULT '[]'::jsonb,
        mentions_ai    BOOLEAN NOT NULL DEFAULT FALSE,
        reply_to       TEXT,
        client_msg_id  TEXT,
        ai_trigger     TEXT,
        edited_at      TIMESTAMPTZ,
        deleted_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT project_comments_thread_seq UNIQUE (thread_id, seq),
        CONSTRAINT project_comments_author
            CHECK (author_kind = 'assistant' OR author_user_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_comments_client
        ON project_comments(thread_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_project_comments_author
        ON project_comments(author_user_id) WHERE author_user_id IS NOT NULL;

    ALTER TABLE project_comment_threads ADD COLUMN IF NOT EXISTS auto_paused_until TIMESTAMPTZ;

    -- Threads on tasks: a table made before that only allowed notebooks and documents.
    DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_comment_threads_target_type_check'
                          AND pg_get_constraintdef(oid) LIKE '%task%') THEN
            ALTER TABLE project_comment_threads DROP CONSTRAINT IF EXISTS project_comment_threads_target_type_check;
            ALTER TABLE project_comment_threads ADD CONSTRAINT project_comment_threads_target_type_check
                CHECK (target_type IN ('notebook', 'document', 'task'));
        END IF;
    END $$;
`;

/**
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {{ ready?: () => Promise<void>, maxCommentsListed?: number, threadPage?: number }} [opts]
 *        `maxCommentsListed` and `threadPage` (one page of a thread read whole): test seams
 */
function makeProjectCommentStore(db, { ready = async () => {}, maxCommentsListed = MAX_COMMENTS_LISTED, threadPage = MAX_COMMENTS_PER_THREAD } = {}) {
    // One factory per concern (stores/lib/projectComment*.js), all over the
    // same db and ready; the store is their union.
    const threadReads = makeThreadReads(db, ready, { maxCommentsListed });
    const { getThread, getThreadById, listThreads } = threadReads;
    const { createThread, setAiMode, setAutoPausedUntil, setStatus } = makeThreadState(db, ready, getThread);
    const { deleteThread, deleteForTarget, deleteForTargetInProject, lookupTarget } = makeThreadRemoval(db, ready);
    const { appendComment, editComment, softDeleteComment } = makeCommentWrites(db, ready);
    const { getComment, listComments, pageComments } = makeCommentReads(db, ready, { threadPage });
    const { countCommentsByAuthor, eraseAuthor } = makeCommentErasure(db, ready);

    return {
        createThread,
        getThread,
        getThreadById,
        listThreads,
        setAiMode,
        setAutoPausedUntil,
        setStatus,
        deleteThread,
        deleteForTarget,
        deleteForTargetInProject,
        lookupTarget,
        appendComment,
        getComment,
        listComments,
        pageComments,
        editComment,
        softDeleteComment,
        countCommentsByAuthor,
        eraseAuthor,
    };
}

const initDB = makeStoreInit('ProjectCommentStore', _initDB);

async function _initDB() {
    // Every store's init starts at once at boot, so the FK target is created
    // first rather than assumed.
    await require('./projectStore').initDB();
    await exec(DDL);
    log.info('[ProjectCommentStore] PostgreSQL initialized');
}

const defaultStore = makeProjectCommentStore({
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => withTransaction((client) => fn({ query: (sql, params) => client.query(sql, params) })),
}, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    TARGET_TYPES,
    THREAD_AI_MODES,
    THREAD_STATUSES,
    MAX_COMMENTS_LISTED,
    MIN_COMMENTS_PER_THREAD,
    ProjectCommentStoreError,
    makeProjectCommentStore,
    rowToThread,
    rowToComment,
    ...defaultStore,
};
