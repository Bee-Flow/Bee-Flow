// @typecheck
/**
 * stores/project/conversations.js — the conversations filed in a project:
 * the counts and the shared-thread list a kind change or delete reads, the
 * caller's own filing, and (un)assigning the caller's own conversation.
 * Split out of stores/projectStore.js; built per store by makeProjectStore.
 */

const { NO_SHARING_SCHEMA } = require('./rows');

/**
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<any>,
 *   initDB: () => Promise<unknown>,
 * }} ctx  the store's db facade and schema init (built by makeProjectStore)
 */
function makeConversationFns({ run, getOne, getAll, initDB }) {
    /**
     * How many of the things only a collaborative project holds are in this
     * one: conversations filed in it (direct and agent, shared or not) and
     * team chats. Read before a project becomes a Solution, which holds
     * neither. A table this install does not have counts 0.
     *
     * @param {string} projectId
     * @returns {Promise<{ conversations: number, teamChats: number }>}
     */
    async function countChatHoldings(projectId) {
        await initDB();
        /**
         * @param {string} sql
         */
        const count = async (sql) => {
            try {
                const row = await getOne(sql, [projectId]);
                return Number(row?.n) || 0;
            } catch (err) {
                if (NO_SHARING_SCHEMA.has(err?.code)) return 0;
                throw err;
            }
        };
        const [direct, agent, teamChats] = [
            await count('SELECT COUNT(*) AS n FROM direct_conversations WHERE project_id = $1'),
            await count('SELECT COUNT(*) AS n FROM agent_conversations WHERE project_id = $1'),
            await count('SELECT COUNT(*) AS n FROM project_chats WHERE project_id = $1'),
        ];
        return { conversations: direct + agent, teamChats };
    }

    /**
     * How many conversations are SHARED into this project (direct and agent).
     *
     * Deleting a project with one still shared cannot succeed: the conversation
     * FKs set `project_id` to NULL on delete, and a shared conversation must
     * keep its project (CHECK `shared_scope = 'private' OR project_id IS NOT
     * NULL`), so Postgres refuses the whole DELETE. Unsharing re-encrypts under
     * the owner's key, which only the owner's session holds, so the delete
     * route asks for that first instead of attempting it.
     *
     * @param {string} projectId
     * @returns {Promise<number>}
     */
    async function countSharedThreads(projectId) {
        await initDB();
        try {
            const row = await getOne(
                `SELECT (SELECT COUNT(*) FROM direct_conversations WHERE project_id = $1 AND shared_scope = 'project')
                      + (SELECT COUNT(*) FROM agent_conversations  WHERE project_id = $1 AND shared_scope = 'project') AS n`,
                [projectId]
            );
            return Number(row?.n) || 0;
        } catch (err) {
            // No conversation tables, or none with sharing: nothing can be shared.
            if (NO_SHARING_SCHEMA.has(err?.code)) return 0;
            throw err;
        }
    }

    /**
     * The conversations SHARED into this project, as ids only: which chat,
     * which table, and whose it is. What a refused project delete names, so
     * the owner knows whom to ask: only a conversation's own owner can unshare
     * it (it is re-encrypted under their key). Oldest share first, capped.
     *
     * @param {string} projectId
     * @param {{ limit?: number }} [opts]
     * @returns {Promise<Array<{ id: string, type: 'direct'|'agent', ownerId: string }>>}
     */
    async function listSharedThreads(projectId, { limit = 20 } = {}) {
        await initDB();
        const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
        try {
            const rows = await getAll(
                `SELECT id, user_id, type FROM (
                    SELECT id, user_id, 'direct' AS type, shared_at FROM direct_conversations
                     WHERE project_id = $1 AND shared_scope = 'project'
                    UNION ALL
                    SELECT id, user_id, 'agent' AS type, shared_at FROM agent_conversations
                     WHERE project_id = $1 AND shared_scope = 'project'
                 ) s
                 ORDER BY shared_at NULLS FIRST, id
                 LIMIT $2`,
                [projectId, cap]
            );
            return rows.map(r => ({ id: r.id, type: r.type === 'agent' ? 'agent' : 'direct', ownerId: r.user_id }));
        } catch (err) {
            if (NO_SHARING_SCHEMA.has(err?.code)) return [];
            throw err;
        }
    }

    /**
     * Where one of the caller's OWN conversations is filed, and whether it is
     * shared there. Matches on `user_id`, so it never says anything about
     * somebody else's conversation: that reads as null, like one that does
     * not exist.
     *
     * @param {string} conversationId
     * @param {string} userId
     * @param {string} [tableName]  'direct_conversations' | 'agent_conversations'
     * @returns {Promise<{ projectId: string|null, shared: boolean }|null>}
     */
    async function getOwnConversationFiling(conversationId, userId, tableName = 'direct_conversations') {
        await initDB();
        if (!conversationId || !userId) return null;
        const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
        try {
            const row = await getOne(
                `SELECT project_id, shared_scope FROM ${safeTable} WHERE id = $1 AND user_id = $2`,
                [conversationId, userId]
            );
            return row ? { projectId: row.project_id || null, shared: row.shared_scope === 'project' } : null;
        } catch (err) {
            if (NO_SHARING_SCHEMA.has(err?.code)) return null;
            throw err;
        }
    }

    // ── Conversation assignment ──────────────────────────────

    // Both helpers require userId so we only touch conversations the caller owns.
    // Without this guard, anyone with editor+ on a project could attach (or detach)
    // other users' conversations via the project assignment endpoint.
    /**
     * @param {string} [tableName]
     */
    async function assignConversation(conversationId, projectId, userId, tableName = 'direct_conversations') {
        await initDB();
        if (!userId) return false;
        const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
        const { rowCount } = await run(
            `UPDATE ${safeTable} SET project_id = $1 WHERE id = $2 AND user_id = $3`,
            [projectId, conversationId, userId]
        );
        return rowCount > 0;
    }

    /**
     * @param {string} [tableName]
     */
    async function unassignConversation(conversationId, userId, tableName = 'direct_conversations') {
        await initDB();
        if (!userId) return false;
        const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
        const { rowCount } = await run(
            `UPDATE ${safeTable} SET project_id = NULL WHERE id = $1 AND user_id = $2`,
            [conversationId, userId]
        );
        return rowCount > 0;
    }

    return {
        countChatHoldings,
        listSharedThreads,
        getOwnConversationFiling,
        countSharedThreads,
        assignConversation,
        unassignConversation,
    };
}

module.exports = { makeConversationFns };
