// @typecheck noImplicitAny
'use strict';
/**
 * The thread-level half of the project comment store (../projectCommentStore.js):
 * reading and listing threads, starting them, their AI mode and status, and
 * removing them (one, or every thread on an item). Anchors stay sealed.
 */

const {
    TARGET_TYPES, THREAD_AI_MODES, THREAD_STATUSES, MAX_THREADS_LISTED,
    MIN_COMMENTS_PER_THREAD, MAX_COMMENTS_PER_THREAD,
    ProjectCommentStoreError, toInt, rowToThread, rowToComment, assertChoice,
} = require('./projectCommentRows');

/** @typedef {import('./projectCommentRows').Queryable} Queryable */
/** @typedef {import('./projectCommentRows').NewComment} NewComment */

/**
 * Insert one comment with the next seq of a thread the caller has locked,
 * and move the thread's counters. Returns the stored comment.
 *
 * @param {Queryable} q
 * @param {{ id: string, project_id: string, last_seq: any }} thread  the locked row
 * @param {NewComment} c
 */
async function insertComment(q, thread, c) {
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

/**
 * Reads: one thread, and the threads on an item with their comments.
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 * @param {{ maxCommentsListed: number }} opts
 */
function makeThreadReads(db, ready, { maxCommentsListed }) {
    /**
     * One thread, only when it belongs to this project.
     * @param {string} projectId
     * @param {string} threadId
     */
    async function getThread(projectId, threadId) {
        await ready();
        const r = await db.query('SELECT * FROM project_comment_threads WHERE id = $1 AND project_id = $2', [threadId, projectId]);
        return rowToThread(r.rows[0] || null);
    }

    /**
     * One thread by id alone, for a background job that holds only the id
     * (the participation surface). Routes use getThread, which also checks the
     * project.
     * @param {string} threadId
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

    return { getThread, getThreadById, listThreads };
}

/**
 * Writes: start a thread (with its first comment), its AI mode, pause and status. `getThread` comes from makeThreadReads.
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 * @param {Function} getThread
 */
function makeThreadState(db, ready, getThread) {
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
            const first = await insertComment(q, thread, { ...comment, authorKind: 'user', authorUserId: createdBy, replyTo: null });
            const fresh = (await q.query('SELECT * FROM project_comment_threads WHERE id = $1', [id])).rows[0];
            return { thread: rowToThread(fresh), comment: first, created: true };
        });
    }

    /**
     * Change the thread's AI mode. Returns the thread, or null when it does
     * not exist in this project.
     * @param {string} aiMode
     * @param {string} projectId
     * @param {string} threadId
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

    return { createThread, setAiMode, setAutoPausedUntil, setStatus };
}

/**
 * Removal: one thread, or every thread on an item; and finding the item a thread is on.
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeThreadRemoval(db, ready) {
    /**
     * Delete a thread; its comments cascade.
     * @param {string} projectId
     * @param {string} threadId
     */
    async function deleteThread(projectId, threadId) {
        await ready();
        const r = await db.query('DELETE FROM project_comment_threads WHERE id = $1 AND project_id = $2 RETURNING id', [threadId, projectId]);
        return r.rows.length > 0;
    }

    /**
     * Every thread on an item, in every project: for the item's own delete
     * path. Returns how many threads went.
     * @param {string} targetType
     * @param {string} targetId
     */
    async function deleteForTarget(targetType, targetId) {
        await ready();
        const r = await db.query(
            'DELETE FROM project_comment_threads WHERE target_type = $1 AND target_id = $2 RETURNING id',
            [targetType, targetId],
        );
        return r.rows.length;
    }

    /**
     * The threads one project holds on an item: for taking the item out of the project.
     * @param {string} projectId
     * @param {string} targetType
     * @param {string} targetId
     */
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
        /** @type {string} */
        let sql;
        if (targetType === 'notebook') sql = 'SELECT id, project_id, name FROM notebooks WHERE id = $1';
        else if (targetType === 'document') sql = `SELECT id, project_id, name FROM studio_documents WHERE id = $1 AND kind = 'document' AND archived = false`;
        // A task's title is sealed with the project key: the name is read where the item is read (projects/comments/passage.js).
        else if (targetType === 'task') sql = `SELECT id, project_id, '' AS name FROM project_tasks WHERE id = $1`;
        else return null;
        const row = (await db.query(sql, [targetId])).rows[0];
        return row ? { id: row.id, projectId: row.project_id || null, name: row.name || '' } : null;
    }

    return { deleteThread, deleteForTarget, deleteForTargetInProject, lookupTarget };
}

module.exports = { insertComment, makeThreadReads, makeThreadState, makeThreadRemoval };
