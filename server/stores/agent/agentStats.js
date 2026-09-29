// @typecheck
/**
 * Agent Stats - Reporting statistics across agents and conversations
 */

const { getOne, getAll, pool } = require('../../db');
const { initDB } = require('./initSchema');

async function getSystemStats(startDate = null, endDate = null) {
    await initDB();
    let totalAgents, totalConversations, activeConversations, allConvs;

    if (!startDate && !endDate) {
        totalAgents = (await getOne("SELECT COUNT(*) as count FROM agents WHERE owner_id NOT IN ('system', 'swarm')")).count;
        totalConversations = (await getOne('SELECT COUNT(*) as count FROM agent_conversations')).count;
        activeConversations = (await getOne("SELECT COUNT(*) as count FROM agent_conversations WHERE updated_at > NOW() - INTERVAL '7 days'")).count;
        allConvs = await getAll('SELECT agent_id, messages_json FROM agent_conversations');
    } else {
        totalAgents = (await getOne("SELECT COUNT(*) as count FROM agents WHERE ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)", [startDate, endDate])).count;
        totalConversations = (await getOne('SELECT COUNT(*) as count FROM agent_conversations WHERE ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)', [startDate, endDate])).count;
        activeConversations = (await getOne("SELECT COUNT(*) as count FROM agent_conversations WHERE updated_at > NOW() - INTERVAL '7 days' AND ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)", [startDate, endDate])).count;
        allConvs = await getAll('SELECT agent_id, messages_json FROM agent_conversations WHERE ($1::text IS NULL OR created_at >= $1) AND ($2::text IS NULL OR created_at <= $2)', [startDate, endDate]);
    }

    let totalMessages = 0;
    const agentMessageCounts = {};
    for (const row of allConvs) {
        try {
            const msgs = JSON.parse(row.messages_json || '[]');
            totalMessages += msgs.length;
            agentMessageCounts[row.agent_id] = (agentMessageCounts[row.agent_id] || 0) + msgs.length;
        } catch (e) { /* ignore parse errors */ }
    }

    return { totalAgents, totalConversations, activeConversations, totalMessages, agentMessageCounts };
}

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
        try { messageCount += JSON.parse(row.messages_json || '[]').length; } catch (e) { }
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
 * @param {object}  [opts]
 * @param {string|null} [opts.excludeUserId] whose conversations do NOT count
 *   towards `othersConversationCount`
 * @param {object}  [opts.db] injection seam for the tests
 * @returns {Promise<Map<string, {conversationCount:number, userCount:number,
 *   othersConversationCount:number, lastUsedAt:string|null}>>} one entry per
 *   requested id — an agent nobody ever chatted with reads as zeros, which is
 *   a fact this query establishes rather than a gap it papers over.
 */
async function getAgentChatStats(agentIds, { excludeUserId = null, db = pool } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, {
        conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null,
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
