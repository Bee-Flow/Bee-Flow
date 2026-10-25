// @typecheck noImplicitAny
'use strict';
/**
 * The comment-level half of the project comment store (../projectCommentStore.js):
 * appending to a thread (next seq under its lock), reading and paging, editing
 * and deleting. Content stays sealed.
 */

const { DEFAULT_CONTEXT, ProjectCommentStoreError, toInt, rowToComment } = require('./projectCommentRows');
const { insertComment } = require('./projectCommentThreads');

/** @typedef {import('./projectCommentRows').Queryable} Queryable */
/** @typedef {import('./projectCommentRows').NewComment} NewComment */

/**
 * Append, edit and soft-delete a comment.
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 */
function makeCommentWrites(db, ready) {
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
        return db.tx(/** @returns {Promise<{ comment: ReturnType<typeof rowToComment>, created: boolean, reopened: boolean, stale: boolean }|null>} */ async (q) => {
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
            const comment = await insertComment(q, thread, c);
            return { comment, created: true, reopened, stale: false };
        });
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
     * @param {string} threadId
     * @param {string} commentId
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

    return { appendComment, editComment, softDeleteComment };
}

/**
 * One comment, the latest of a thread, and a thread page by page.
 * @param {Queryable & { tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T> }} db
 * @param {() => Promise<void>} ready
 * @param {{ threadPage: number }} opts
 */
function makeCommentReads(db, ready, { threadPage }) {
    /**
     * One comment, only when it belongs to this thread.
     * @param {string} threadId
     * @param {string} commentId
     */
    async function getComment(threadId, commentId) {
        await ready();
        const r = await db.query('SELECT * FROM project_comments WHERE id = $1 AND thread_id = $2', [commentId, threadId]);
        return rowToComment(r.rows[0] || null);
    }

    /**
     * The latest `limit` comments of a thread, ascending by seq (sealed).
     * @param {string} threadId
     * @param {{ limit?: number }} [opts]
     */
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

    return { getComment, listComments, pageComments };
}

module.exports = { makeCommentWrites, makeCommentReads };
