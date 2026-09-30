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

const TARGET_TYPES = Object.freeze(['notebook', 'document', 'task']);
const THREAD_AI_MODES = Object.freeze(['off', 'mention', 'auto']);
const THREAD_STATUSES = Object.freeze(['open', 'resolved']);
const MAX_THREADS_LISTED = 300;
/** All comments of one list answer, shared out fairly between its threads. */
const MAX_COMMENTS_LISTED = 3000;
/** A thread's share of the list: never fewer than this… */
const MIN_COMMENTS_PER_THREAD = 10;
/** …and never more than one page of a single thread's own read serves. */
const MAX_COMMENTS_PER_THREAD = 500;
const DEFAULT_CONTEXT = 50;

/**
 * The schema, idempotent and PGlite-safe (no extensions). Exported so the pg
 * test creates exactly what production creates.
 */
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

/** A refusal the route turns into a worded 4xx. */
class ProjectCommentStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'ProjectCommentStoreError';
        this.code = code;
    }
}

const toIso = (v) => (v ? new Date(v).toISOString() : null);
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

/** @returns {string[]} */
function idsOf(v) {
    let list = v;
    if (typeof v === 'string') {
        try { list = JSON.parse(v); } catch (_) { list = []; }
    }
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

/** A thread row as stored. `anchor` is still sealed (or null). */
function rowToThread(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        targetType: r.target_type,
        targetId: r.target_id,
        anchor: r.anchor ?? null,
        status: r.status,
        aiMode: r.ai_mode,
        createdBy: r.created_by,
        clientThreadId: r.client_thread_id || null,
        resolvedBy: r.resolved_by || null,
        resolvedAt: toIso(r.resolved_at),
        commentCount: toInt(r.comment_count),
        lastSeq: toInt(r.last_seq),
        lastCommentAt: toIso(r.last_comment_at),
        autoPausedUntil: toIso(r.auto_paused_until),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

/** A comment row as stored. `content` is still sealed ('' once deleted). */
function rowToComment(r) {
    if (!r) return null;
    return {
        id: r.id,
        threadId: r.thread_id,
        projectId: r.project_id,
        seq: toInt(r.seq),
        authorKind: r.author_kind,
        authorUserId: r.author_user_id || null,
        agentId: r.agent_id || null,
        content: r.content,
        mentions: idsOf(r.mentions),
        mentionsAi: !!r.mentions_ai,
        replyTo: r.reply_to || null,
        clientMsgId: r.client_msg_id || null,
        aiTrigger: r.ai_trigger || null,
        editedAt: toIso(r.edited_at),
        deletedAt: toIso(r.deleted_at),
        createdAt: toIso(r.created_at),
    };
}

function assertChoice(value, allowed, code, label) {
    if (!allowed.includes(value)) throw new ProjectCommentStoreError(code, `${label} must be one of ${allowed.join(', ')}`);
}

/**
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} Queryable
 * @typedef {{ id: string, authorKind?: 'user'|'assistant', authorUserId?: string|null, agentId?: string|null,
 *             content: string, mentions?: string[], mentionsAi?: boolean, replyTo?: string|null,
 *             clientMsgId?: string|null, aiTrigger?: string|null }} NewComment  `content` sealed
 */

/**
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {{ ready?: () => Promise<void>, maxCommentsListed?: number, threadPage?: number }} [opts]
 *        `maxCommentsListed` and `threadPage` (one page of a thread read whole): test seams
 */
function makeProjectCommentStore(db, { ready = async () => {}, maxCommentsListed = MAX_COMMENTS_LISTED, threadPage = MAX_COMMENTS_PER_THREAD } = {}) {
    /**
     * Insert one comment with the next seq of a thread the caller has locked,
     * and move the thread's counters. Returns the stored comment.
     *
     * @param {Queryable} q
     * @param {{ id: string, project_id: string, last_seq: any }} thread  the locked row
     * @param {NewComment} c
     */
    async function _insertComment(q, thread, c) {
        const seq = toInt(thread.last_seq) + 1;
        const row = (await q.query(
            `INSERT INTO project_comments
                (id, thread_id, project_id, seq, author_kind, author_user_id, agent_id,
                 content, mentions, mentions_ai, reply_to, client_msg_id, ai_trigger)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
             RETURNING *`,
            [c.id, thread.id, thread.project_id, seq, c.authorKind || 'user', c.authorUserId || null, c.agentId || null,
                c.content, JSON.stringify(c.mentions || []), !!c.mentionsAi, c.replyTo || null, c.clientMsgId || null,
                c.aiTrigger || null],
        )).rows[0];
        await q.query(
            `UPDATE project_comment_threads
                SET last_seq = $2, comment_count = comment_count + 1,
                    last_comment_at = $3, updated_at = $3
              WHERE id = $1`,
            [thread.id, seq, row.created_at],
        );
        return rowToComment(row);
    }

    // ── Threads ───────────────────────────────────────────────────────────

    /**
     * Start a thread with its first comment, in one transaction.
     *
     * Returns `{ thread, comment, created }`; `created` is false when
     * `clientThreadId` names a thread this author already started (the
     * thread and its first comment are answered as they are).
     *
     * @param {{ id: string, projectId: string, targetType: string, targetId: string,
     *           anchor?: string|null, createdBy: string, aiMode?: string,
     *           clientThreadId?: string|null, comment: NewComment }} t  `anchor` sealed
     */
    async function createThread(t) {
        await ready();
        const { id, projectId, targetType, targetId, anchor = null, createdBy, aiMode = 'mention', clientThreadId = null, comment } = t;
        assertChoice(targetType, TARGET_TYPES, 'INVALID_TARGET_TYPE', 'targetType');
        assertChoice(aiMode, THREAD_AI_MODES, 'INVALID_AI_MODE', 'aiMode');
        return db.tx(async (q) => {
            if (clientThreadId) {
                const existing = (await q.query(
                    'SELECT * FROM project_comment_threads WHERE project_id = $1 AND client_thread_id = $2',
                    [projectId, clientThreadId],
                )).rows[0];
                if (existing) {
                    if (existing.created_by !== createdBy) {
                        throw new ProjectCommentStoreError('CLIENT_ID_TAKEN', 'This clientThreadId was already used for another thread in this project.');
                    }
                    const first = (await q.query(
                        'SELECT * FROM project_comments WHERE thread_id = $1 ORDER BY seq ASC LIMIT 1',
                        [existing.id],
                    )).rows[0];
                    return { thread: rowToThread(existing), comment: rowToComment(first || null), created: false };
                }
            }
            const thread = (await q.query(
                `INSERT INTO project_comment_threads
                    (id, project_id, target_type, target_id, anchor, ai_mode, created_by, client_thread_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [id, projectId, targetType, targetId, anchor, aiMode, createdBy, clientThreadId],
            )).rows[0];
            const first = await _insertComment(q, thread, { ...comment, authorKind: 'user', authorUserId: createdBy, replyTo: null });
            const fresh = (await q.query('SELECT * FROM project_comment_threads WHERE id = $1', [id])).rows[0];
            return { thread: rowToThread(fresh), comment: first, created: true };
        });
    }

    /** One thread, only when it belongs to this project. */
    async function getThread(projectId, threadId) {
        await ready();
        const r = await db.query('SELECT * FROM project_comment_threads WHERE id = $1 AND project_id = $2', [threadId, projectId]);
        return rowToThread(r.rows[0] || null);
    }

    /**
     * One thread by id alone, for a background job that holds only the id
     * (the participation surface). Routes use getThread, which also checks the
     * project.
     */
    async function getThreadById(threadId) {
        await ready();
        const r = await db.query('SELECT * FROM project_comment_threads WHERE id = $1', [threadId]);
        return rowToThread(r.rows[0] || null);
    }

    /**
     * The threads on one item, oldest first, each with its comments ascending
     * by seq (still sealed). `status` narrows to open or resolved threads.
     *
     * The comments are capped PER THREAD, so a busy item can never leave a
     * thread without its comments: each thread gets an equal share of
     * MAX_COMMENTS_LISTED (between MIN_ and MAX_COMMENTS_PER_THREAD), made of
     * its first comment and its latest ones. `omittedComments` counts those
     * left out in between; the whole thread is read page by page (pageComments).
     *
     * @param {string} projectId
     * @param {{ targetType: string, targetId: string, status?: 'open'|'resolved'|'all' }} where
     */
    async function listThreads(projectId, { targetType, targetId, status = 'all' }) {
        await ready();
        const params = [projectId, targetType, targetId, MAX_THREADS_LISTED];
        let byStatus = '';
        if (status === 'open' || status === 'resolved') { params.push(status); byStatus = ` AND status = $${params.length}`; }
        const threads = (await db.query(
            `SELECT * FROM project_comment_threads
              WHERE project_id = $1 AND target_type = $2 AND target_id = $3${byStatus}
              ORDER BY created_at ASC, id ASC
              LIMIT $4`,
            params,
        )).rows.map(rowToThread);
        if (threads.length === 0) return [];
        const perThread = Math.min(MAX_COMMENTS_PER_THREAD,
            Math.max(MIN_COMMENTS_PER_THREAD, Math.floor(maxCommentsListed / threads.length)));
        const rows = (await db.query(
            `SELECT * FROM (
                SELECT c.*,
                       ROW_NUMBER() OVER (PARTITION BY c.thread_id ORDER BY c.seq ASC) AS from_start,
                       ROW_NUMBER() OVER (PARTITION BY c.thread_id ORDER BY c.seq DESC) AS from_end,
                       COUNT(*) OVER (PARTITION BY c.thread_id) AS in_thread
                  FROM project_comments c
                 WHERE c.thread_id = ANY($1::text[])
             ) ranked
             WHERE from_start = 1 OR from_end < $2
             ORDER BY thread_id, seq ASC`,
            [threads.map((t) => t.id), perThread],
        )).rows;
        /** @type {Map<string, { comments: any[], total: number }>} */
        const byThread = new Map();
        for (const row of rows) {
            const entry = byThread.get(row.thread_id) || { comments: [], total: toInt(row.in_thread) };
            entry.comments.push(rowToComment(row));
            byThread.set(row.thread_id, entry);
        }
        return threads.map((t) => {
            const entry = byThread.get(t.id);
            if (!entry) return { ...t, comments: [], omittedComments: 0 };
            return { ...t, comments: entry.comments, omittedComments: Math.max(0, entry.total - entry.comments.length) };
        });
    }

    /**
     * Change the thread's AI mode. Returns the thread, or null when it does
     * not exist in this project.
     */
    async function setAiMode(projectId, threadId, aiMode) {
        await ready();
        assertChoice(aiMode, THREAD_AI_MODES, 'INVALID_AI_MODE', 'aiMode');
        const r = await db.query(
            `UPDATE project_comment_threads SET ai_mode = $3, updated_at = NOW()
              WHERE id = $1 AND project_id = $2
              RETURNING *`,
            [threadId, projectId, aiMode],
        );
        return rowToThread(r.rows[0] || null);
    }

    /**
     * Pause the AI joining this thread by itself until `until` (after "not
     * helpful" feedback), or lift the pause with null. Returns the thread, or
     * null when it does not exist.
     *
     * @param {string} threadId
     * @param {Date|null} until
     */
    async function setAutoPausedUntil(threadId, until) {
        await ready();
        const r = await db.query(
            'UPDATE project_comment_threads SET auto_paused_until = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
            [threadId, until ? until.toISOString() : null],
        );
        return rowToThread(r.rows[0] || null);
    }

    /**
     * Resolve or reopen. Returns `{ thread, changed }` (`changed` false when it
     * already had that status), or null when the thread is not in this project.
     *
     * @param {string} projectId
     * @param {string} threadId
     * @param {'open'|'resolved'} status
     * @param {string} userId  who resolved it (kept for 'resolved' only)
     */
    async function setStatus(projectId, threadId, status, userId) {
        await ready();
        assertChoice(status, THREAD_STATUSES, 'INVALID_STATUS', 'status');
        const resolved = status === 'resolved';
        const r = await db.query(
            `UPDATE project_comment_threads
                SET status = $3,
                    resolved_by = CASE WHEN $3 = 'resolved' THEN $4 ELSE NULL END,
                    resolved_at = CASE WHEN $3 = 'resolved' THEN NOW() ELSE NULL END,
                    updated_at = NOW()
              WHERE id = $1 AND project_id = $2 AND status <> $3
              RETURNING *`,
            [threadId, projectId, status, resolved ? userId : null],
        );
        if (r.rows[0]) return { thread: rowToThread(r.rows[0]), changed: true };
        const current = await getThread(projectId, threadId);
        return current ? { thread: current, changed: false } : null;
    }

    /** Delete a thread; its comments cascade. */
    async function deleteThread(projectId, threadId) {
        await ready();
        const r = await db.query('DELETE FROM project_comment_threads WHERE id = $1 AND project_id = $2 RETURNING id', [threadId, projectId]);
        return r.rows.length > 0;
    }

    /**
     * Every thread on an item, in every project: for the item's own delete
     * path. Returns how many threads went.
     */
    async function deleteForTarget(targetType, targetId) {
        await ready();
        const r = await db.query(
            'DELETE FROM project_comment_threads WHERE target_type = $1 AND target_id = $2 RETURNING id',
            [targetType, targetId],
        );
        return r.rows.length;
    }

    /** The threads one project holds on an item: for taking the item out of the project. */
    async function deleteForTargetInProject(projectId, targetType, targetId) {
        await ready();
        const r = await db.query(
            'DELETE FROM project_comment_threads WHERE project_id = $1 AND target_type = $2 AND target_id = $3 RETURNING id',
            [projectId, targetType, targetId],
        );
        return r.rows.length;
    }

    /**
     * The id, project and name of the item a thread is about, or null. A
     * document counts only while it is a live document (not a template, not
     * archived) — the same rule that makes it readable through a project.
     *
     * @param {string} targetType
     * @param {string} targetId
     * @returns {Promise<{ id: string, projectId: string|null, name: string }|null>}
     */
    async function lookupTarget(targetType, targetId) {
        await ready();
        let sql;
        if (targetType === 'notebook') sql = 'SELECT id, project_id, name FROM notebooks WHERE id = $1';
        else if (targetType === 'document') sql = `SELECT id, project_id, name FROM studio_documents WHERE id = $1 AND kind = 'document' AND archived = false`;
        // A task's title is sealed with the project key: the name is read where the item is read (projects/comments/passage.js).
        else if (targetType === 'task') sql = `SELECT id, project_id, '' AS name FROM project_tasks WHERE id = $1`;
        else return null;
        const row = (await db.query(sql, [targetId])).rows[0];
        return row ? { id: row.id, projectId: row.project_id || null, name: row.name || '' } : null;
    }

    // ── Comments ──────────────────────────────────────────────────────────

    /**
     * Append a comment under the thread row lock.
     *
     * Returns `{ comment, created, reopened }` (`created` false for an
     * idempotent retry), or null when the thread does not exist in this
     * project. A person's reply to a resolved thread reopens it (`reopened`);
     * with `requireOpen` (the AI's answers) a resolved thread is refused
     * instead. With `staleAfterSeq` (an automatic answer) nothing is stored
     * when a person commented after that seq — checked under the thread lock,
     * so it cannot race a reply — and the answer says `stale: true`.
     *
     * @param {string} projectId
     * @param {string} threadId
     * @param {NewComment} c
     * @param {{ requireOpen?: boolean, staleAfterSeq?: number|null }} [opts]
     * @returns {Promise<{ comment: ReturnType<typeof rowToComment>, created: boolean, reopened: boolean, stale: boolean }|null>}
     */
    async function appendComment(projectId, threadId, c, { requireOpen = false, staleAfterSeq = null } = {}) {
        await ready();
        return db.tx(async (q) => {
            const thread = (await q.query(
                'SELECT id, project_id, status, last_seq FROM project_comment_threads WHERE id = $1 AND project_id = $2 FOR UPDATE',
                [threadId, projectId],
            )).rows[0];
            if (!thread) return null;

            if (c.clientMsgId) {
                const existing = (await q.query(
                    'SELECT * FROM project_comments WHERE thread_id = $1 AND client_msg_id = $2',
                    [threadId, c.clientMsgId],
                )).rows[0];
                if (existing) {
                    if ((existing.author_user_id || null) !== (c.authorUserId || null)) {
                        throw new ProjectCommentStoreError('CLIENT_ID_TAKEN', 'This clientMsgId was already used for another comment in this thread.');
                    }
                    return { comment: rowToComment(existing), created: false, reopened: false, stale: false };
                }
            }
            if (thread.status === 'resolved' && requireOpen) {
                throw new ProjectCommentStoreError('THREAD_RESOLVED', 'This thread is resolved.');
            }
            if (Number.isFinite(staleAfterSeq)) {
                const later = await q.query(
                    `SELECT 1 FROM project_comments WHERE thread_id = $1 AND author_kind = 'user' AND seq > $2 LIMIT 1`,
                    [threadId, staleAfterSeq],
                );
                if (later.rows.length > 0) return { comment: null, created: false, reopened: false, stale: true };
            }
            if (c.replyTo) {
                const target = await q.query('SELECT 1 FROM project_comments WHERE id = $1 AND thread_id = $2', [c.replyTo, threadId]);
                if (target.rows.length === 0) {
                    throw new ProjectCommentStoreError('REPLY_TARGET_NOT_FOUND', 'replyTo must be a comment in this thread.');
                }
            }
            let reopened = false;
            if (thread.status === 'resolved') {
                await q.query(
                    `UPDATE project_comment_threads
                        SET status = 'open', resolved_by = NULL, resolved_at = NULL
                      WHERE id = $1`,
                    [threadId],
                );
                reopened = true;
            }
            const comment = await _insertComment(q, thread, c);
            return { comment, created: true, reopened, stale: false };
        });
    }

    /** One comment, only when it belongs to this thread. */
    async function getComment(threadId, commentId) {
        await ready();
        const r = await db.query('SELECT * FROM project_comments WHERE id = $1 AND thread_id = $2', [commentId, threadId]);
        return rowToComment(r.rows[0] || null);
    }

    /** The latest `limit` comments of a thread, ascending by seq (sealed). */
    async function listComments(threadId, { limit = DEFAULT_CONTEXT } = {}) {
        await ready();
        const n = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_CONTEXT, 1), 500);
        const r = await db.query(
            'SELECT * FROM project_comments WHERE thread_id = $1 ORDER BY seq DESC LIMIT $2',
            [threadId, n],
        );
        return r.rows.reverse().map(rowToComment);
    }

    /**
     * One page of a thread read whole, newest first in pages: its latest
     * comments before `beforeSeq` (the latest of all when null), at most
     * `threadPage`, ascending by seq (sealed), and `earlier`: how many of its
     * comments are older than these. The next page is asked before the first
     * of them; a thread of any length is read to its first comment this way.
     *
     * @param {string} threadId
     * @param {{ beforeSeq?: number|null }} [opts]
     * @returns {Promise<{ comments: any[], earlier: number }>}
     */
    async function pageComments(threadId, { beforeSeq = null } = {}) {
        await ready();
        const before = Number.isInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : null;
        const r = await db.query(
            `SELECT c.*, COUNT(*) OVER () AS matching
               FROM project_comments c
              WHERE c.thread_id = $1 AND ($3::bigint IS NULL OR c.seq < $3::bigint)
              ORDER BY c.seq DESC
              LIMIT $2`,
            [threadId, threadPage, before],
        );
        const matching = r.rows.length > 0 ? toInt(r.rows[0].matching) : 0;
        return { comments: r.rows.reverse().map(rowToComment), earlier: Math.max(0, matching - r.rows.length) };
    }

    /**
     * Replace a comment's content (and its mentions). Only the author's own,
     * not-deleted, human comment matches: the predicate is the rule, the
     * route's check is the worded refusal in front of it.
     *
     * @param {string} threadId
     * @param {string} commentId
     * @param {string} authorUserId
     * @param {{ content: string, mentions?: string[], mentionsAi?: boolean }} change  `content` sealed
     */
    async function editComment(threadId, commentId, authorUserId, { content, mentions = [], mentionsAi = false }) {
        await ready();
        const r = await db.query(
            `UPDATE project_comments
                SET content = $4, mentions = $5::jsonb, mentions_ai = $6, edited_at = NOW()
              WHERE id = $2 AND thread_id = $1 AND author_kind = 'user'
                AND author_user_id = $3 AND deleted_at IS NULL
              RETURNING *`,
            [threadId, commentId, authorUserId, content, JSON.stringify(mentions || []), !!mentionsAi],
        );
        return rowToComment(r.rows[0] || null);
    }

    /**
     * Soft delete: the row keeps its seq (so the thread stays gapless and the
     * replies below it keep their place) and loses its content and mentions.
     * The ciphertext is overwritten, not kept.
     */
    async function softDeleteComment(threadId, commentId) {
        await ready();
        return db.tx(async (q) => {
            const r = await q.query(
                `UPDATE project_comments
                    SET content = '', mentions = '[]'::jsonb, mentions_ai = FALSE, deleted_at = NOW()
                  WHERE id = $2 AND thread_id = $1 AND deleted_at IS NULL
                  RETURNING *`,
                [threadId, commentId],
            );
            const row = r.rows[0];
            if (!row) return null;
            await q.query(
                `UPDATE project_comment_threads
                    SET comment_count = GREATEST(comment_count - 1, 0), updated_at = NOW()
                  WHERE id = $1`,
                [threadId],
            );
            return rowToComment(row);
        });
    }

    // ── The data subject ─────────────────────────────────────────────────

    /**
     * How many comments one person wrote in the projects of one organisation
     * (a DSR discovery source). A count only: nothing is opened.
     *
     * @param {string} userId
     * @param {{ organizationId: string }} scope
     */
    async function countCommentsByAuthor(userId, { organizationId }) {
        await ready();
        if (!userId || !organizationId) return 0;
        const r = await db.query(
            `SELECT COUNT(*)::int AS n
               FROM project_comments c
               JOIN projects p ON p.id = c.project_id
              WHERE c.author_user_id = $1 AND p.organization_id = $2`,
            [userId, organizationId],
        );
        return toInt(r.rows[0] && r.rows[0].n);
    }

    /**
     * Erase what a deleted account wrote: every comment they authored is
     * soft-deleted the way they could delete it themselves, and their id is
     * taken out of other people's mention lists. Threads they started stay,
     * because the replies in them are other people's.
     *
     * @param {string} userId
     * @returns {Promise<{ comments: number, mentions: number }>}
     */
    async function eraseAuthor(userId) {
        await ready();
        if (!userId) return { comments: 0, mentions: 0 };
        return db.tx(async (q) => {
            const wiped = await q.query(
                `UPDATE project_comments
                    SET content = '', mentions = '[]'::jsonb, mentions_ai = FALSE, deleted_at = NOW()
                  WHERE author_user_id = $1 AND deleted_at IS NULL
                  RETURNING thread_id`,
                [userId],
            );
            /** @type {Map<string, number>} */
            const perThread = new Map();
            for (const row of wiped.rows) perThread.set(row.thread_id, (perThread.get(row.thread_id) || 0) + 1);
            for (const [threadId, count] of perThread) {
                await q.query(
                    `UPDATE project_comment_threads
                        SET comment_count = GREATEST(comment_count - $2, 0), updated_at = NOW()
                      WHERE id = $1`,
                    [threadId, count],
                );
            }
            const unmentioned = await q.query(
                `UPDATE project_comments SET mentions = mentions - $1::text
                  WHERE mentions ? $1::text
                  RETURNING id`,
                [userId],
            );
            return { comments: wiped.rows.length, mentions: unmentioned.rows.length };
        });
    }

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
