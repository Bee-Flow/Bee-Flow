// @typecheck
/**
 * stores/memoryReads.js — reading memories: the lists (personal, project pool,
 * agent bucket), the paginated search (in SQL, or in JS over decrypted rows
 * when anything is sealed) and the by-id reads. Split out of stores/memoryStore.js.
 */

const { getOne, getAll } = require('../db');
const { dep } = require('./memoryDeps');
const { resolveWriteContext, hydrateRows, ENVELOPE_LIKE } = dep('memoryCrypto');

/** The store's schema-init memo, installed by stores/memoryStore (read per call). */
const initDB = () => dep('initDB')();

// How many of a person's rows the encrypted search decrypts and scans in JS
// (see searchUserMemories). The org's maxPerUser, when the caller passes it.
const DEFAULT_SCAN_LIMIT = 1000;

async function getMemories(userId, limit = 50) {
    await initDB();
    return hydrateRows(await getAll(`
        SELECT * FROM user_memories WHERE user_id = $1 AND status = 'active' AND project_id IS NULL
        ORDER BY importance DESC, updated_at DESC LIMIT $2
    `, [userId, limit]));
}

/**
 * Paginated + searchable user-global memory list. Returns the page plus the
 * total count so the UI can show "Load more" / progress.
 *
 * Search matches against content, subject, attribute, value (case-insensitive).
 * Type filter is applied at the DB level so pagination is consistent.
 *
 * SQL cannot search a sealed column. When the person has any sealed row, or the
 * org seals memory now, the search runs in JS instead: their rows (newest and
 * most important first, at most `scanLimit`, which the caller takes from the
 * org's maxPerUser) are decrypted and filtered here. `truncated` is true when
 * the scan hit the limit, i.e. older rows were not searched.
 */
async function searchUserMemories(userId, { limit = 50, offset = 0, search = null, type = null, scanLimit = DEFAULT_SCAN_LIMIT } = {}) {
    await initDB();
    const where = [`user_id = $1`, `status = 'active'`, `project_id IS NULL`];
    const params = [userId];
    if (type) {
        params.push(type);
        where.push(`type = $${params.length}`);
    }
    const needle = search && String(search).trim() ? String(search).trim() : '';
    const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    if (needle && await _searchMustRunInJs(userId)) {
        const cap = Math.max(1, Math.min(10000, parseInt(String(scanLimit), 10) || DEFAULT_SCAN_LIMIT));
        const rows = await getAll(`
            SELECT * FROM user_memories WHERE ${where.join(' AND ')}
            ORDER BY importance DESC, updated_at DESC LIMIT ${cap}
        `, params);
        const q = needle.toLowerCase();
        const hits = (await hydrateRows(rows)).filter(m =>
            [m.content, m.subject, m.attribute, m.value].some(v => typeof v === 'string' && v.toLowerCase().includes(q)));
        return {
            items: hits.slice(safeOffset, safeOffset + safeLimit),
            total: hits.length, limit: safeLimit, offset: safeOffset, truncated: rows.length >= cap,
        };
    }

    if (needle) {
        params.push(`%${needle}%`);
        const idx = params.length;
        where.push(`(content ILIKE $${idx} OR subject ILIKE $${idx} OR attribute ILIKE $${idx} OR value ILIKE $${idx})`);
    }
    const whereSql = where.join(' AND ');
    params.push(safeLimit);
    params.push(safeOffset);
    const items = await getAll(`
        SELECT * FROM user_memories WHERE ${whereSql}
        ORDER BY importance DESC, updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const countRow = await getOne(`SELECT COUNT(*)::int AS total FROM user_memories WHERE ${whereSql}`, params.slice(0, -2));
    return { items: await hydrateRows(items), total: countRow?.total || 0, limit: safeLimit, offset: safeOffset };
}

/** Does a text search over this person's memory have to happen after decryption? */
async function _searchMustRunInJs(userId) {
    const sealed = await getOne(
        `SELECT 1 AS present FROM user_memories
          WHERE user_id = $1 AND project_id IS NULL AND status = 'active' AND content LIKE '${ENVELOPE_LIKE}' LIMIT 1`,
        [userId]);
    if (sealed) return true;
    return (await resolveWriteContext({ userId })).encrypt;
}

async function getMemoriesForProject(userId, projectId, limit = 50) {
    await initDB();
    return hydrateRows(await getAll(`
        SELECT m.*, u."displayName" as created_by_name, u.username as created_by_username 
        FROM user_memories m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.project_id = $1 AND m.status = 'active'
        ORDER BY m.importance DESC, m.updated_at DESC LIMIT $2
    `, [projectId, limit]));
}

async function getMemoriesForAgent(userId, agentId, limit = 20, { includeGeneral = true } = {}) {
    await initDB();
    // includeGeneral=true (default): return agent-specific + user-global memories.
    // includeGeneral=false: only this agent's bucket — used when an agent has
    // memoryEnabled and explicitly opts out of reading the user's general memory.
    if (includeGeneral) {
        return hydrateRows(await getAll(`
            SELECT * FROM user_memories
            WHERE user_id = $1 AND status = 'active' AND (agent_id = $2 OR agent_id IS NULL)
            ORDER BY importance DESC, updated_at DESC LIMIT $3
        `, [userId, agentId, limit]));
    }
    return hydrateRows(await getAll(`
        SELECT * FROM user_memories
        WHERE user_id = $1 AND status = 'active' AND agent_id = $2
        ORDER BY importance DESC, updated_at DESC LIMIT $3
    `, [userId, agentId, limit]));
}

// By-id reads keep a row they cannot open (`unreadable: true`, sealed text
// blanked): the route still has to authorise it and the owner has to be able to
// delete it. List reads drop such a row instead.
async function getMemoryById(id) {
    await initDB();
    const row = await getOne('SELECT * FROM user_memories WHERE id = $1', [id]);
    return row ? (await hydrateRows([row], { keepUnreadable: true }))[0] : null;
}

/** Many rows by id in one query, for authorising a bulk action. */
async function getMemoriesByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    await initDB();
    return hydrateRows(await getAll('SELECT * FROM user_memories WHERE id = ANY($1::text[])', [ids]), { keepUnreadable: true });
}

module.exports = {
    DEFAULT_SCAN_LIMIT,
    getMemories, searchUserMemories, getMemoriesForProject, getMemoriesForAgent, getMemoryById, getMemoriesByIds,
};
