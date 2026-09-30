/**
 * "My chats in this project" — the caller's OWN direct and agent
 * conversations filed under a project, shared or not.
 *
 * Filing (`project_id`) and sharing (`shared_scope = 'project'`) are two acts
 * (see stores/agent/initSchema.js): a chat filed in a project stays private
 * until its owner shares it. The project's thread list shows only the shared
 * ones, to everyone; this list shows the caller's own, to the caller, with a
 * `shared` flag so the workspace can offer "Share" / "Stop sharing".
 *
 * Every query is scoped with `user_id = <caller>`. Nobody else's chat can be
 * listed here, whatever their role in the project.
 *
 * Titles are opened with the caller's own context. On every tier and every
 * scope a title stays under its owner's key — sharing re-keys the messages,
 * not the title (sharedConversations.js) — and the owner is the caller.
 *
 * `makeMyProjectChats(db, deps)` takes a `{ query }` db, so the SQL runs
 * against a real Postgres in its test; the default instance uses the pool.
 */

'use strict';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const LIST_SQL = `
    SELECT id, title, updated_at, shared_scope, NULL::text AS agent_id, 'direct' AS conv_type
      FROM direct_conversations
     WHERE user_id = $1 AND project_id = $2
    UNION ALL
    SELECT id, title, updated_at, shared_scope, agent_id::text AS agent_id, 'agent' AS conv_type
      FROM agent_conversations
     WHERE user_id = $1 AND project_id = $2
     ORDER BY updated_at DESC
     LIMIT $3`;

// A pre-migration install has no shared_scope column; there, nothing is shared.
const LEGACY_SQL = `
    SELECT id, title, updated_at, 'private' AS shared_scope, NULL::text AS agent_id, 'direct' AS conv_type
      FROM direct_conversations
     WHERE user_id = $1 AND project_id = $2
    UNION ALL
    SELECT id, title, updated_at, 'private' AS shared_scope, agent_id::text AS agent_id, 'agent' AS conv_type
      FROM agent_conversations
     WHERE user_id = $1 AND project_id = $2
     ORDER BY updated_at DESC
     LIMIT $3`;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[]}> }} db
 * @param {object} [deps]
 * @param {() => Promise<void>} [deps.ready]  schema init to await first
 * @param {(opts: {userId: string}) => Promise<object>} [deps.resolveCrypto]
 * @param {(stored: any, id: string, type: string, ctx: object) => any} [deps.openTitle]
 */
function makeMyProjectChats(db, deps = {}) {
    const ready = deps.ready || (async () => {});
    const resolveCrypto = deps.resolveCrypto
        || ((opts) => require('../stores/agent/messageCrypto').resolveCrypto(opts));
    const openTitle = deps.openTitle
        || ((stored, id, type, ctx) => require('../stores/agent/conversationTitle').openTitle(stored, id, type, ctx));

    /**
     * @param {string} userId
     * @param {string} projectId
     * @param {{limit?: number}} [opts]
     * @returns {Promise<Array<{id: string, type: 'direct'|'agent', agentId: string|null,
     *   title: string|null, updatedAt: any, shared: boolean}>>}
     */
    async function list(userId, projectId, { limit = DEFAULT_LIMIT } = {}) {
        if (!userId || !projectId) return [];
        await ready();
        const capped = Math.min(Math.max(1, Math.trunc(Number(limit)) || DEFAULT_LIMIT), MAX_LIMIT);

        let rows;
        try {
            ({ rows } = await db.query(LIST_SQL, [userId, projectId, capped]));
        } catch (err) {
            if (!/column .* does not exist/i.test(err.message)) throw err;
            ({ rows } = await db.query(LEGACY_SQL, [userId, projectId, capped]));
        }
        if (!rows || rows.length === 0) return [];

        // One context for the whole page: every row belongs to the caller.
        const ctx = await resolveCrypto({ userId });
        return rows.map(r => {
            const type = r.conv_type === 'agent' ? 'agent' : 'direct';
            // openTitle yields null for a title that will not open, so one bad
            // row cannot take the list down.
            const title = openTitle(r.title, r.id, type, ctx);
            return {
                id: r.id,
                type,
                agentId: type === 'agent' ? (r.agent_id || null) : null,
                title: typeof title === 'string' ? title : null,
                updatedAt: r.updated_at,
                shared: r.shared_scope === 'project',
            };
        });
    }

    return { list };
}

const defaultInstance = makeMyProjectChats(
    { query: (sql, params) => require('../db').pool.query(sql, params) },
    { ready: () => require('../stores/agent/initSchema').initDB() },
);

module.exports = { makeMyProjectChats, list: defaultInstance.list, DEFAULT_LIMIT, MAX_LIMIT };
