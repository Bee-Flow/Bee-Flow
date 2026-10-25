// @typecheck noImplicitAny
'use strict';
/**
 * The chat-level half of the project chat store (../projectChatStore.js):
 * reading and listing a project's chats, and creating, updating and
 * deleting them. Titles stay sealed here, as everywhere in the store.
 */

const { AI_MODES, MAX_CHATS_LISTED, ProjectChatStoreError, toInt, rowToChat } = require('./projectChatRows');

/**
 * Reads: one chat, the readers past a seq, the project's chat list.
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {() => Promise<void>} ready
 */
function makeChatReads(db, ready) {
    /**
     * One chat, only when it belongs to this project.
     * @param {string} projectId
     * @param {string} chatId
     */
    async function getChat(projectId, chatId) {
        await ready();
        const r = await db.query('SELECT * FROM project_chats WHERE id = $1 AND project_id = $2', [chatId, projectId]);
        return rowToChat(r.rows[0] || null);
    }

    /**
     * One chat by its id alone. For the background participation job only,
     * which starts from a queued chat id and authorises nothing: routes look
     * a chat up THROUGH its project with getChat.
     * @param {string} chatId
     */
    async function getChatById(chatId) {
        await ready();
        const r = await db.query('SELECT * FROM project_chats WHERE id = $1', [chatId]);
        return rowToChat(r.rows[0] || null);
    }

    /**
     * How many people other than `exceptUserId` have read up to `seq` or further.
     * @param {string} chatId
     * @param {number} seq
     * @param {string | null} [exceptUserId]
     */
    async function countReadersAtLeast(chatId, seq, exceptUserId = null) {
        await ready();
        const r = await db.query(
            `SELECT COUNT(*)::int AS n FROM project_chat_reads
              WHERE chat_id = $1 AND last_read_seq >= $2 AND user_id IS DISTINCT FROM $3`,
            [chatId, seq, exceptUserId],
        );
        return toInt(r.rows[0] && r.rows[0].n);
    }

    /**
     * The project's chats, most recently active first, each with its latest
     * visible message (still sealed) and the caller's unread count. Unread
     * counts other people's and the assistant's messages after the caller's
     * read marker; one's own messages are never unread.
     *
     * @param {string} projectId
     * @param {{ userId: string, archived?: boolean }} opts
     */
    async function listChats(projectId, { userId, archived = false }) {
        await ready();
        const r = await db.query(
            `SELECT c.*,
                    lm.id AS lm_id, lm.author_kind AS lm_author_kind,
                    lm.author_user_id AS lm_author_user_id, lm.content AS lm_content,
                    lm.notice AS lm_notice,
                    COALESCE(un.unread, 0) AS unread
               FROM project_chats c
               LEFT JOIN project_chat_reads r ON r.chat_id = c.id AND r.user_id = $2
               LEFT JOIN LATERAL (
                    SELECT m.id, m.author_kind, m.author_user_id, m.content, m.notice
                      FROM project_chat_messages m
                     WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                     ORDER BY m.seq DESC
                     LIMIT 1
               ) lm ON TRUE
               LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int AS unread
                      FROM project_chat_messages m
                     WHERE m.chat_id = c.id
                       AND m.deleted_at IS NULL
                       AND m.seq > COALESCE(r.last_read_seq, 0)
                       AND m.author_user_id IS DISTINCT FROM $2
               ) un ON TRUE
              WHERE c.project_id = $1 AND c.archived = $3
              ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id ASC
              LIMIT $4`,
            [projectId, userId, !!archived, MAX_CHATS_LISTED],
        );
        return r.rows.map((row) => ({
            ...rowToChat(row),
            unread: toInt(row.unread),
            lastMessage: row.lm_id
                ? {
                    id: row.lm_id,
                    authorKind: row.lm_author_kind,
                    authorUserId: row.lm_author_user_id || null,
                    content: row.lm_content,
                    notice: row.lm_notice || null,
                }
                : null,
        }));
    }

    return { getChat, getChatById, countReadersAtLeast, listChats };
}

/**
 * Writes: create, pause the AI, update, delete. `getChat` comes from makeChatReads.
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {() => Promise<void>} ready
 * @param {Function} getChat
 */
function makeChatWrites(db, ready, getChat) {
    /**
     * `titleFromMessageId` names the message a title was taken from (see
     * "Titles taken from a message" above).
     *
     * @param {{ id: string, projectId: string, title: string, createdBy: string,
     *           aiMode?: string, agentId?: string|null, titleFromMessageId?: string|null }} chat  `title` sealed
     */
    async function createChat({ id, projectId, title, createdBy, aiMode = 'mention', agentId = null, titleFromMessageId = null }) {
        await ready();
        if (!AI_MODES.includes(aiMode)) throw new ProjectChatStoreError('INVALID_AI_MODE', `aiMode must be one of ${AI_MODES.join(', ')}`);
        const r = await db.query(
            `INSERT INTO project_chats (id, project_id, title, created_by, ai_mode, agent_id, title_from_message_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [id, projectId, title, createdBy, aiMode, agentId, titleFromMessageId || null],
        );
        return rowToChat(r.rows[0]);
    }

    /**
     * Pause (or, with null, resume) the AI joining on its own in this chat.
     * @param {string} chatId
     * @param {string|Date|null} until
     */
    async function setAutoPausedUntil(chatId, until) {
        await ready();
        const r = await db.query(
            'UPDATE project_chats SET auto_paused_until = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
            [chatId, until ? new Date(until).toISOString() : null],
        );
        return rowToChat(r.rows[0] || null);
    }

    /**
     * Change what the caller asked to change. `agentId: null` clears the agent;
     * a key that is absent is left alone.
     *
     * @param {string} projectId
     * @param {string} chatId
     * @param {{ title?: string, aiMode?: string, agentId?: string|null, archived?: boolean }} patch  `title` sealed
     */
    async function updateChat(projectId, chatId, patch) {
        await ready();
        /** @type {string[]} */
        const sets = [];
        /** @type {unknown[]} */
        const params = [chatId, projectId];
        /** @param {string} col @param {unknown} value */
        const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
        if (patch.title !== undefined) {
            // A name somebody chose is no longer the first message's words.
            add('title', patch.title);
            sets.push('title_from_message_id = NULL');
        }
        if (patch.aiMode !== undefined) {
            if (!AI_MODES.includes(patch.aiMode)) throw new ProjectChatStoreError('INVALID_AI_MODE', `aiMode must be one of ${AI_MODES.join(', ')}`);
            add('ai_mode', patch.aiMode);
        }
        if (patch.agentId !== undefined) add('agent_id', patch.agentId);
        if (patch.archived !== undefined) add('archived', !!patch.archived);
        if (sets.length === 0) return getChat(projectId, chatId);
        const r = await db.query(
            `UPDATE project_chats SET ${sets.join(', ')}, updated_at = NOW()
              WHERE id = $1 AND project_id = $2
              RETURNING *`,
            params,
        );
        return rowToChat(r.rows[0] || null);
    }

    /**
     * Delete a chat; its messages and read markers cascade.
     * @param {string} projectId
     * @param {string} chatId
     */
    async function deleteChat(projectId, chatId) {
        await ready();
        const r = await db.query('DELETE FROM project_chats WHERE id = $1 AND project_id = $2 RETURNING id', [chatId, projectId]);
        return r.rows.length > 0;
    }

    return { createChat, setAutoPausedUntil, updateChat, deleteChat };
}

module.exports = { makeChatReads, makeChatWrites };
