// @typecheck strict
/**
 * Agent Stats - Reporting statistics across agents and conversations
 */

const { getOne, getAll, pool } = require('../../db');
const { initDB } = require('./initSchema');
const { fallback } = require('../../utils/bestEffort');

/**
 * The organisations a read is narrowed to, as the WHERE fragments and the
 * parameter they share. `orgIds` null (the super admin's scope) narrows
 * nothing; an array narrows agents on their own column and conversations
 * through the agent they belong to (agent_conversations has no org column).
 * A caller of no organisation sees no agent, like the studio counts.
 *
 * @param {string[] | null | undefined} orgIds
 * @param {number} idx  the placeholder number the fragments may use
 */
function orgNarrowing(orgIds, idx) {
    if (!Array.isArray(orgIds)) return { agents: '', conversations: '', params: [] };
    const ids = orgIds.filter(Boolean).map(String);
    return {
        agents: ` AND organization_id = ANY($${idx}::text[])`,
        conversations: ` AND agent_id IN (SELECT id FROM agents WHERE organization_id = ANY($${idx}::text[]))`,
        params: [ids],
    };
}

/**
 * @param {string | null} [startDate]
 * @param {string | null} [endDate]
 * @param {{ orgIds?: string[] | null }} [scope]  the caller's organisations; null = every organisation
 */
async function getSystemStats(startDate = null, endDate = null, { orgIds = null } = {}) {
    await initDB();
    let totalAgents, totalConversations, activeConversations, allConvs;

    if (!startDate && !endDate) {
        const org = orgNarrowing(orgIds, 1);
        totalAgents = (await getOne(`SELECT COUNT(*) as count FROM agents WHERE owner_id NOT IN ('system', 'swarm')${org.agents}`, org.params)).count;
        totalConversations = (await getOne(`SELECT COUNT(*) as count FROM agent_conversations WHERE TRUE${org.conversations}`, org.params)).count;
        activeConversations = (await getOne(`SELECT COUNT(*) as count FROM agent_conversations WHERE updated_at > NOW() - INTERVAL '7 days'${org.conversations}`, org.params)).count;
        allConvs = await getAll(`SELECT agent_id, messages_json FROM agent_conversations WHERE TRUE${org.conversations}`, org.params);
    } else {
        const org = orgNarrowing(orgIds, 3);
        const params = [startDate, endDate, ...org.params];
        // The bounds are timestamps, cast as such: as `$1::text` the comparison
        // `created_at >= $1` has no operator (timestamptz against text) and
        // Postgres refuses the statement.
        const period = '($1::timestamptz IS NULL OR created_at >= $1::timestamptz) AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz)';
        totalAgents = (await getOne(`SELECT COUNT(*) as count FROM agents WHERE ${period}${org.agents}`, params)).count;
        totalConversations = (await getOne(`SELECT COUNT(*) as count FROM agent_conversations WHERE ${period}${org.conversations}`, params)).count;
        activeConversations = (await getOne(`SELECT COUNT(*) as count FROM agent_conversations WHERE updated_at > NOW() - INTERVAL '7 days' AND ${period}${org.conversations}`, params)).count;
        allConvs = await getAll(`SELECT agent_id, messages_json FROM agent_conversations WHERE ${period}${org.conversations}`, params);
    }

    let totalMessages = 0;
    /** @type {Record<string, number>} */
    const agentMessageCounts = {};
    for (const row of allConvs) {
        try {
            const msgs = JSON.parse(row.messages_json || '[]');
            totalMessages += msgs.length;
            agentMessageCounts[row.agent_id] = (agentMessageCounts[row.agent_id] || 0) + msgs.length;
        } catch (e) { fallback('stores/agent/agentStats:getSystemStats', e); /* ignore parse errors */ }
    }

    return { totalAgents, totalConversations, activeConversations, totalMessages, agentMessageCounts };
}

/** @param {string} agentId */
async function getAgentStats(agentId, startDate = null, endDate = null) {
    await initDB();
    const stats = await getOne(`SELECT
        (SELECT COUNT(*) FROM agent_conversations WHERE agent_id = $1) as conversation_count,
        (SELECT updated_at FROM agents WHERE id = $2) as last_updated`, [agentId, agentId]);

    let sql = 'SELECT messages_json FROM agent_conversations WHERE agent_id = $1';
    const params = [agentId];
    let idx = 2;
    if (startDate) { sql += ` AND created_at >= $${idx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND created_at <= $${idx++}`; params.push(endDate); }

    const convs = await getAll(sql, params);
    const conversationCount = startDate || endDate ? convs.length : (stats?.conversation_count ?? 0);
    let messageCount = 0;
    for (const row of convs) {
        try { messageCount += JSON.parse(row.messages_json || '[]').length; } catch (e) { fallback('stores/agent/agentStats:getAgentStats', e); /* messages_json is not valid JSON, the conversation adds no messages */ }
    }

    return { conversationCount, lastUpdated: stats?.last_updated, messageCount };
}

/**
 * Chat usage for MANY agents in one query — the list's "312 conversations ·
 * last used 2 min ago" and the Used-by tab's Chat row.
 *
 * getAgentStats() cannot serve this: it reads EVERY `messages_json` of the
 * agent into Node to count messages, and its `lastUpdated` is
 * `agents.updated_at` — when the agent was last EDITED, not when it was last
 * used. On a list of 200 agents that is 200 round trips and a lie in the
 * column people read as "still in use".
 *
 * `othersConversationCount` exists for the delete guard. Deleting an agent
 * cascades its conversations away, and on a published agent those belong to
 * colleagues — so the guard has to know whether the history being destroyed
 * is only the asker's own. With `excludeUserId` null it equals
 * `conversationCount`, which is the safe reading when nobody was named.
 *
 * @param {string[]} agentIds
 * @param {{ excludeUserId?: string|null, db?: DbQueryable }} [opts]  excludeUserId: whose conversations do
 *   NOT count towards `othersConversationCount`; db: injection seam for the tests
 * @returns {Promise<Map<string, {conversationCount:number, userCount:number,
 *   othersConversationCount:number, lastUsedAt:string|null}>>} one entry per
 *   requested id — an agent nobody ever chatted with reads as zeros, which is
 *   a fact this query establishes rather than a gap it papers over.
 */
async function getAgentChatStats(agentIds, { excludeUserId = null, db = pool } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, {
        conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: /** @type {(string | null) | null} */ (null),
    }]));
    if (ids.length === 0) return out;
    // Only when running against the real pool: with an injected db the schema
    // belongs to whoever built it.
    if (db === pool) await initDB();

    const r = await db.query(
        `SELECT agent_id,
                COUNT(*)::int                                                        AS conversation_count,
                COUNT(DISTINCT user_id)::int                                         AS user_count,
                COUNT(*) FILTER (WHERE $2::text IS NULL OR user_id <> $2::text)::int AS others_count,
                MAX(updated_at)                                                      AS last_used_at
           FROM agent_conversations
          WHERE agent_id = ANY($1::text[])
          GROUP BY agent_id`,
        [ids, excludeUserId || null],
    );
    for (const row of (r.rows || [])) {
        const entry = out.get(String(row.agent_id));
        if (!entry) continue;
        entry.conversationCount = Number(row.conversation_count) || 0;
        entry.userCount = Number(row.user_count) || 0;
        entry.othersConversationCount = Number(row.others_count) || 0;
        entry.lastUsedAt = row.last_used_at
            ? new Date(row.last_used_at).toISOString()
            : null;
    }
    return out;
}

module.exports = { getSystemStats, getAgentStats, getAgentChatStats };
