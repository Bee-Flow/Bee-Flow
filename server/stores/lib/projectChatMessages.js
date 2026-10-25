// @typecheck noImplicitAny
'use strict';
/**
 * The message-level half of the project chat store (../projectChatStore.js):
 * appending (gapless seq under the chat row's lock), reading and paging,
 * editing and deleting, and the read markers. Content stays sealed here.
 */

const { AUTHOR_KINDS, AI_TRIGGERS, NOTICES, ProjectChatStoreError, toInt, rowToMessage, clampLimit } = require('./projectChatRows');
const { RESET_DERIVED_TITLES, DROP_TRACES } = require('./projectChatSql');

/**
 * Move a member's read marker forward, never back.
 * @param {string} chatId
 * @param {string} userId
 * @param {number} seq
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} q
 */
async function advanceRead(q, chatId, userId, seq) {
    await q.query(
        `INSERT INTO project_chat_reads (chat_id, user_id, last_read_seq, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (chat_id, user_id) DO UPDATE
            SET last_read_seq = GREATEST(project_chat_reads.last_read_seq, EXCLUDED.last_read_seq),
                updated_at = NOW()`,
        [chatId, userId, seq],
    );
}

/**
 * Append a message: the next seq under the chat row's lock.
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {() => Promise<void>} ready
 */
function makeMessageAppend(db, ready) {
    /**
     * Append a message under the chat row lock.
     *
     * Returns `{ message, created }` (`created` false for an idempotent retry),
     * or null when the chat does not exist in this project. The author's own
     * read marker moves to the new message, so one's own post is never unread.
     *
     * `unlessHumanAfterSeq` is the stale-answer check of an automatic answer:
     * when a member posted in the main conversation (a thread reply does not
     * count) after that seq, nothing is stored and the answer is
     * `{ stale: true }`. It runs under the same chat row lock a member's post
     * takes, so no post can slip in between the check and the insert.
     *
     * @param {{ id: string, projectId: string, chatId: string, authorKind: 'user'|'assistant'|'system',
     *           authorUserId?: string|null, agentId?: string|null, content: string,
     *           mentions?: string[], replyTo?: string|null, threadId?: string|null,
     *           refs?: { kind: string, id: string }[], aiMeta?: object|null, aiTrace?: string|null, clientMsgId?: string|null,
     *           aiTrigger?: string|null, aiReason?: string|null, notice?: string|null,
     *           unlessHumanAfterSeq?: number|null }} m  `content` sealed ('' for a notice)
     * @returns {Promise<{ message: ReturnType<typeof rowToMessage>, created: boolean, stale?: false }|{ stale: true }|null>}
     */
    async function appendMessage(m) {
        await ready();
        const {
            id, projectId, chatId, authorKind, authorUserId = null, agentId = null,
            content, mentions = [], replyTo = null, threadId = null, refs = [], aiMeta = null, aiTrace = null, clientMsgId = null,
            aiTrigger = null, aiReason = null, notice = null, unlessHumanAfterSeq = null,
        } = m;
        if (!AUTHOR_KINDS.includes(authorKind)) throw new ProjectChatStoreError('INVALID_AUTHOR', `authorKind must be one of ${AUTHOR_KINDS.join(', ')}`);
        if (aiTrigger !== null && !AI_TRIGGERS.includes(aiTrigger)) throw new ProjectChatStoreError('INVALID_AI_TRIGGER', `aiTrigger must be one of ${AI_TRIGGERS.join(', ')}`);
        if (notice !== null && !NOTICES.includes(notice)) throw new ProjectChatStoreError('INVALID_NOTICE', `notice must be one of ${NOTICES.join(', ')}`);
        const reasonCode = typeof aiReason === 'string' && /^[a-z0-9_]{1,64}$/.test(aiReason) ? aiReason : null;
        return db.tx(async (q) => {
            const chat = (await q.query(
                'SELECT id, last_seq FROM project_chats WHERE id = $1 AND project_id = $2 FOR UPDATE',
                [chatId, projectId],
            )).rows[0];
            if (!chat) return null;

            if (Number.isFinite(unlessHumanAfterSeq)) {
                const newer = await q.query(
                    `SELECT 1 FROM project_chat_messages
                      WHERE chat_id = $1 AND seq > $2 AND author_kind = 'user' AND deleted_at IS NULL
                        AND thread_root_id IS NULL
                      LIMIT 1`,
                    [chatId, unlessHumanAfterSeq],
                );
                if (newer.rows.length > 0) return { stale: /** @type {true} */ (true) };
            }

            if (clientMsgId) {
                const existing = (await q.query(
                    'SELECT * FROM project_chat_messages WHERE chat_id = $1 AND client_msg_id = $2',
                    [chatId, clientMsgId],
                )).rows[0];
                if (existing) {
                    if ((existing.author_user_id || null) !== (authorUserId || null)) {
                        throw new ProjectChatStoreError('CLIENT_MSG_ID_TAKEN', 'This clientMsgId was already used for another message in this chat.');
                    }
                    return { message: rowToMessage(existing), created: false, stale: /** @type {false} */ (false) };
                }
            }

            if (replyTo) {
                const target = await q.query(
                    'SELECT 1 FROM project_chat_messages WHERE id = $1 AND chat_id = $2',
                    [replyTo, chatId],
                );
                if (target.rows.length === 0) {
                    throw new ProjectChatStoreError('REPLY_TARGET_NOT_FOUND', 'replyTo must be a message in this chat.');
                }
            }

            if (threadId) {
                // A thread hangs off a message of the main conversation, never off another reply.
                const root = await q.query(
                    'SELECT 1 FROM project_chat_messages WHERE id = $1 AND chat_id = $2 AND thread_root_id IS NULL',
                    [threadId, chatId],
                );
                if (root.rows.length === 0) {
                    throw new ProjectChatStoreError('THREAD_NOT_FOUND', 'threadId must be a message of this chat that is not itself a reply in a thread.');
                }
            }

            const seq = toInt(chat.last_seq) + 1;
            const inserted = (await q.query(
                `INSERT INTO project_chat_messages
                    (id, chat_id, project_id, seq, author_kind, author_user_id, agent_id,
                     content, mentions, reply_to, thread_root_id, refs, client_msg_id, ai_trigger, ai_reason, notice, ai_meta, ai_trace)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::jsonb, $18)
                 RETURNING *`,
                [id, chatId, projectId, seq, authorKind, authorUserId, agentId,
                    content, JSON.stringify(mentions || []), replyTo, threadId, JSON.stringify(refs || []), clientMsgId,
                    authorKind === 'assistant' ? aiTrigger : null,
                    authorKind === 'assistant' ? reasonCode : null,
                    authorKind === 'system' ? notice : null,
                    authorKind === 'assistant' && aiMeta ? JSON.stringify(aiMeta) : null,
                    authorKind === 'assistant' ? aiTrace : null],
            )).rows[0];
            await q.query(
                `UPDATE project_chats
                    SET last_seq = $2, message_count = message_count + 1,
                        last_message_at = $3, updated_at = $3
                  WHERE id = $1`,
                [chatId, seq, inserted.created_at],
            );
            // A notice is written on a member's behalf, not read by them.
            if (authorUserId && authorKind !== 'system') await advanceRead(q, chatId, authorUserId, seq);
            return { message: rowToMessage(inserted), created: true, stale: /** @type {false} */ (false) };
        });
    }

    return { appendMessage };
}

/**
 * Reads: one message, and a page of messages.
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {() => Promise<void>} ready
 */
function makeMessageReads(db, ready) {
    /**
     * One message, only when it belongs to this chat.
     * @param {string} chatId
     * @param {string} messageId
     */
    async function getMessage(chatId, messageId) {
        await ready();
        const r = await db.query('SELECT * FROM project_chat_messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
        return rowToMessage(r.rows[0] || null);
    }

    /**
     * A page of messages, ascending by seq.
     *
     *   after=N       the messages after N (live catch-up); hasMore = newer exist
     *   before=N      the messages before N (scroll back);  hasMore = older exist
     *   neither       the latest page;                     hasMore = older exist
     *   both          the messages strictly between them, ascending
     *
     * `threadId` narrows the page to one conversation: a root id is that
     * message and its replies, `null` is the main conversation without any
     * thread reply; left out, everything comes back (the chat view).
     *
     * @param {string} chatId
     * @param {{ after?: number|null, before?: number|null, limit?: number, threadId?: string|null }} [opts]
     */
    async function listMessages(chatId, { after = null, before = null, limit, threadId = undefined } = {}) {
        await ready();
        const n = clampLimit(limit);
        /** The narrowing clause; a thread's id is pushed onto `params`. @param {any[]} params */
        const scoped = (params) => {
            if (threadId === null) return ' AND thread_root_id IS NULL';
            if (typeof threadId !== 'string') return '';
            params.push(threadId);
            return ` AND (id = $${params.length} OR thread_root_id = $${params.length})`;
        };
        if (after !== null && after !== undefined) {
            const params = [chatId, after, n + 1];
            let bound = '';
            if (before !== null && before !== undefined) { params.push(before); bound = ` AND seq < $${params.length}`; }
            bound += scoped(params);
            const r = await db.query(
                `SELECT * FROM project_chat_messages
                  WHERE chat_id = $1 AND seq > $2${bound}
                  ORDER BY seq ASC
                  LIMIT $3`,
                params,
            );
            const hasMore = r.rows.length > n;
            return { messages: r.rows.slice(0, n).map(rowToMessage), hasMore };
        }
        const params = [chatId, n + 1];
        let bound = '';
        if (before !== null && before !== undefined) { params.push(before); bound = ` AND seq < $${params.length}`; }
        bound += scoped(params);
        const r = await db.query(
            `SELECT * FROM project_chat_messages
              WHERE chat_id = $1${bound}
              ORDER BY seq DESC
              LIMIT $2`,
            params,
        );
        const hasMore = r.rows.length > n;
        return { messages: r.rows.slice(0, n).reverse().map(rowToMessage), hasMore };
    }

    return { getMessage, listMessages };
}

/**
 * Edits: edit, retitle from, soft-delete, and the read marker.
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {() => Promise<void>} ready
 */
function makeMessageEdits(db, ready) {
    /**
     * Replace a message's content. Only the author's own, not-deleted, human
     * message matches — the predicate is the rule, the route's check is the
     * worded refusal in front of it. The traces of answers to it are dropped.
     * @param {string} chatId
     * @param {string} messageId
     * @param {string} authorUserId
     * @param {string} content
     */
    async function editMessage(chatId, messageId, authorUserId, content) {
        await ready();
        return db.tx(async (q) => {
            const r = await q.query(
                `UPDATE project_chat_messages
                    SET content = $4, edited_at = NOW()
                  WHERE id = $2 AND chat_id = $1 AND author_kind = 'user'
                    AND author_user_id = $3 AND deleted_at IS NULL
                  RETURNING *`,
                [chatId, messageId, authorUserId, content],
            );
            // The trace of an answer to this message holds it as it WAS written (an IBAN the author has just
            // removed, say): it goes with the old words, as it does when the message is deleted.
            if (r.rows[0]) await q.query(DROP_TRACES, [[messageId]]);
            return rowToMessage(r.rows[0] || null);
        });
    }

    /**
     * Give a chat whose title was taken from `messageId` a new sealed title
     * (after that message was edited). A chat named otherwise is left alone.
     * @returns {Promise<boolean>} whether the title changed
     * @param {string} chatId
     * @param {string} messageId
     * @param {string} title
     */
    async function retitleFromMessage(chatId, messageId, title) {
        await ready();
        const r = await db.query(
            `UPDATE project_chats SET title = $3, updated_at = NOW()
              WHERE id = $1 AND title_from_message_id = $2`,
            [chatId, messageId, title],
        );
        return (r.rowCount || 0) > 0;
    }

    /**
     * Soft delete: the row keeps its seq (so cursors stay gapless) and loses
     * its content and mentions. The ciphertext is overwritten, not kept, and
     * so is a title taken from this message (`titleReset` says so).
     *
     * @returns {Promise<(ReturnType<typeof rowToMessage> & { titleReset: boolean })|null>}
     * @param {string} chatId
     * @param {string} messageId
     */
    async function softDeleteMessage(chatId, messageId) {
        await ready();
        return db.tx(async (q) => {
            const r = await q.query(
                `UPDATE project_chat_messages
                    SET content = '', mentions = '[]'::jsonb, refs = '[]'::jsonb, deleted_at = NOW()
                  WHERE id = $2 AND chat_id = $1 AND deleted_at IS NULL
                  RETURNING *`,
                [chatId, messageId],
            );
            const row = r.rows[0];
            if (!row) return null;
            await q.query(
                `UPDATE project_chats
                    SET message_count = GREATEST(message_count - 1, 0), updated_at = NOW()
                  WHERE id = $1`,
                [chatId],
            );
            await q.query(DROP_TRACES, [[messageId]]);
            const reset = await q.query(RESET_DERIVED_TITLES, [[messageId]]);
            return { ...rowToMessage(row), titleReset: (reset.rowCount || 0) > 0 };
        });
    }

    /**
     * Move the caller's read marker to `seq` (clamped to the chat's last seq,
     * never backwards). Returns the stored marker, or null for no such chat.
     * @param {string} chatId
     * @param {string} userId
     * @param {number} seq
     */
    async function markRead(chatId, userId, seq) {
        await ready();
        const r = await db.query(
            `INSERT INTO project_chat_reads (chat_id, user_id, last_read_seq, updated_at)
             SELECT c.id, $2, LEAST($3::bigint, c.last_seq), NOW()
               FROM project_chats c
              WHERE c.id = $1
             ON CONFLICT (chat_id, user_id) DO UPDATE
                SET last_read_seq = GREATEST(project_chat_reads.last_read_seq, EXCLUDED.last_read_seq),
                    updated_at = NOW()
             RETURNING last_read_seq`,
            [chatId, userId, seq],
        );
        return r.rows[0] ? toInt(r.rows[0].last_read_seq) : null;
    }

    return { editMessage, retitleFromMessage, softDeleteMessage, markRead };
}

module.exports = { makeMessageAppend, makeMessageReads, makeMessageEdits };
