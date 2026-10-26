// @typecheck strict
/**
 * Conversation search shared by the agent and the direct conversation stores.
 *
 * Four strategies, applied in priority order:
 *
 *  A  (SQL JOIN): title matches AND migrated-conversation content matches, one
 *     query with a LEFT JOIN on conversation_messages.
 *  A2 (app-side, encrypted migrated rows): `cm.content ILIKE` / `c.title ILIKE`
 *     match nothing against ciphertext (and the GIN trigram index on content is
 *     dead weight), so without this pass search would silently return fewer
 *     results once either surface is encrypted. Decrypts a bounded candidate set.
 *  B  (SQL ILIKE on the legacy blob): no encryption key, so messages_json is
 *     plain text for non-migrated conversations.
 *  C  (app-side, encrypted legacy blobs): only when encryptionKey is set and
 *     the conversation is not migrated yet; bounded to 200 rows.
 *
 * The caller finishes the result (title opening, sort, cap, row shape): the
 * two stores do that differently and each keeps its own tail.
 */

const log = require('../../telemetry/log');

// The store modules hand their own db and crypto functions in (`deps`): the
// conversation crypto modules sit in the server's large import cycle, and a
// require from here would pull this file into it.

/**
 * @typedef {object} ConversationSearchSpec
 * @property {string} table           conversation table (agent_conversations | direct_conversations)
 * @property {'agent'|'direct'} kind  title AAD type
 * @property {string} cols            leading row columns, before messages_json / messages_migrated
 * @property {string} [extraCols]     columns after messages_migrated (e.g. joined agent name)
 * @property {string} [joins]         extra JOINs on every query
 * @property {string} [messageJoin]   extra ON condition for the conversation_messages join
 * @property {boolean} [agentIdFilter] honour filters.agentId
 * @property {string} logTag          log prefix
 */

/**
 * @typedef {object} ConversationSearchDeps
 * @property {(sql: string, params: any[]) => Promise<any[]>} getAll
 * @property {(args: { userId: string, encryptionKey: any }) => Promise<any>} resolveCrypto
 * @property {(stored: any, id: string, type: string, ctx: any) => any} openTitle
 * @property {(id: string, ctx: any) => Promise<any>} getMessages
 * @property {(blob: string, key: any, id: string, userId: string) => string} decryptMessages
 */

/** @type {ConversationSearchSpec} Agent conversations: joined agent name/avatar and an agentId filter. */
const AGENT_SEARCH = {
    table: 'agent_conversations',
    kind: 'agent',
    cols: 'c.id, c.agent_id, c.user_id, c.title, c.updated_at',
    extraCols: 'a.name AS agent_name, a.avatar AS agent_avatar',
    joins: 'LEFT JOIN agents a ON c.agent_id = a.id',
    agentIdFilter: true,
    logTag: '[AgentConversations]',
};

/** @type {ConversationSearchSpec} Direct conversations: message rows are shared, so the join filters on type. */
const DIRECT_SEARCH = {
    table: 'direct_conversations',
    kind: 'direct',
    cols: 'c.id, c.user_id, c.title, c.updated_at, c.model_tier',
    messageJoin: "AND cm.conversation_type = 'direct'",
    logTag: '[DirectConversations]',
};

/**
 * @param {ConversationSearchSpec} spec
 * @param {ConversationSearchDeps} deps
 * @param {string} userId
 * @param {string} query
 * @param {{ agentId?: string, startDate?: string, endDate?: string }} filters
 * @param {any} encryptionKey
 * @returns {Promise<{ results: any[], searchCtx: any }>}
 */
async function searchConversationRows(spec, deps, userId, query, filters, encryptionKey) {
    const { getAll, resolveCrypto, openTitle, getMessages, decryptMessages } = deps;
    const { table, kind, cols, logTag } = spec;
    const extra = spec.extraCols ? `, ${spec.extraCols}` : '';
    const joins = spec.joins || '';
    const rowCols = `${cols}, c.messages_migrated${extra}`;
    const blobCols = `${cols}, c.messages_json, c.messages_migrated${extra}`;

    const likeQuery = `%${query}%`;
    const lowerQuery = query.toLowerCase();

    // Base filter params (userId is always $1)
    const filterParams = [userId];
    let filterClauses = '';
    let filterIdx = 2;
    if (spec.agentIdFilter && filters.agentId) { filterClauses += ` AND c.agent_id = $${filterIdx++}`; filterParams.push(filters.agentId); }
    if (filters.startDate) { filterClauses += ` AND c.updated_at >= $${filterIdx++}`; filterParams.push(filters.startDate); }
    if (filters.endDate) { filterClauses += ` AND c.updated_at <= $${filterIdx++}`; filterParams.push(filters.endDate); }
    // likeQuery is the next param after the filter params
    const likeIdx = filterIdx;

    // ── Strategy A: title OR migrated message content (single JOIN query) ────
    const stratA = await getAll(`
        SELECT DISTINCT ${rowCols}
        FROM ${table} c
        ${joins}
        LEFT JOIN conversation_messages cm
            ON cm.conversation_id = c.id ${spec.messageJoin || ''} AND c.messages_migrated = TRUE
        WHERE c.user_id = $1
          AND (c.title ILIKE $${likeIdx} OR cm.content ILIKE $${likeIdx})
          ${filterClauses}
        ORDER BY c.updated_at DESC
        LIMIT 50
    `, [...filterParams, likeQuery]);

    const results = [...stratA];
    const matchedIds = new Set(results.map(r => r.id));

    // ── Strategy A2: migrated conversations whose content or TITLE is ENCRYPTED ──
    const searchCtx = await resolveCrypto({ userId, encryptionKey });
    if (searchCtx.encryptMessages || searchCtx.encryptTitle) {
        const encMigrated = await getAll(`
            SELECT ${rowCols}
            FROM ${table} c
            ${joins}
            WHERE c.user_id = $1
              ${searchCtx.encryptMessages ? 'AND c.messages_migrated = TRUE' : ''}
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 200
        `, filterParams);
        let added = 0;
        for (const conv of encMigrated) {
            if (matchedIds.has(conv.id)) continue;
            try {
                const title = openTitle(conv.title, conv.id, kind, searchCtx);
                let hit = !!title && String(title).toLowerCase().includes(lowerQuery);
                if (!hit && searchCtx.encryptMessages && conv.messages_migrated) {
                    const msgs = await getMessages(conv.id, searchCtx);
                    hit = JSON.stringify(msgs).toLowerCase().includes(lowerQuery);
                }
                if (hit) {
                    results.push({ ...conv, title });
                    matchedIds.add(conv.id);
                    if (++added >= 50) break;
                }
            } catch (e) {
                // One unreadable conversation must not fail the whole search.
                log.error(`${logTag} Search decrypt error for`, conv.id, '-', /** @type {Error} */ (e).message);
            }
        }
    }

    if (!encryptionKey) {
        // ── Strategy B: non-migrated blobs, no encryption — search in SQL ──
        const stratB = await getAll(`
            SELECT ${rowCols}
            FROM ${table} c
            ${joins}
            WHERE c.user_id = $1
              AND c.messages_migrated = FALSE
              AND c.messages_json ILIKE $${likeIdx}
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 50
        `, [...filterParams, likeQuery]);
        for (const r of stratB) {
            if (!matchedIds.has(r.id)) { results.push(r); matchedIds.add(r.id); }
        }
    } else {
        // ── Strategy C: non-migrated encrypted blobs — bounded JS fallback ──
        const encCandidates = await getAll(`
            SELECT ${blobCols}
            FROM ${table} c
            ${joins}
            WHERE c.user_id = $1
              AND c.messages_migrated = FALSE
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 200
        `, filterParams);
        let cAdded = 0;
        for (const conv of encCandidates) {
            if (matchedIds.has(conv.id)) continue;
            try {
                const decrypted = decryptMessages(conv.messages_json || '[]', encryptionKey, conv.id, userId);
                if (decrypted.toLowerCase().includes(lowerQuery)) {
                    results.push({ ...conv, messages_json: decrypted });
                    matchedIds.add(conv.id);
                    if (++cAdded >= 50) break;
                }
            } catch (e) {
                log.error(`${logTag} Search decrypt error:`, e);
            }
        }
    }

    return { results, searchCtx };
}

/**
 * Newest first, as both stores return search results.
 * @param {{ updated_at: string | number | Date }} a
 * @param {{ updated_at: string | number | Date }} b
 */
function byUpdatedDesc(a, b) {
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

module.exports = { searchConversationRows, byUpdatedDesc, AGENT_SEARCH, DIRECT_SEARCH };
