// @typecheck strict
/**
 * Agent categories of an organisation: list, create, rename, reassign, delete.
 */

const { randomUUID } = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { buildUpdate } = require('../lib/sqlBuilder');

/** @param {string | null | undefined} orgId */
async function getAgentCategories(orgId) {
    await initDB();
    if (orgId) {
        return getAll('SELECT * FROM agent_categories WHERE organization_id = $1 ORDER BY name ASC', [orgId]);
    }
    return getAll('SELECT * FROM agent_categories ORDER BY name ASC');
}

/**
 * @param {string | null | undefined} orgId
 * @param {string} name
 * @param {string | null | undefined} icon
 * @param {string | null | undefined} color
 */
async function createAgentCategory(orgId, name, icon, color) {
    await initDB();
    const id = randomUUID();
    await run('INSERT INTO agent_categories (id, organization_id, name, icon, color) VALUES ($1,$2,$3,$4,$5)',
        [id, orgId || null, name, icon || '📁', color || '#6366f1']);
    return { id, organization_id: orgId, name, icon: icon || '📁', color: color || '#6366f1' };
}

// Full category management. The DELETE route has preferred this
// helper since 2026-03 (`typeof agentStore.countAgentsInCategory === 'function'`)
// but it never existed — every delete paid a full getAllAgents() scan.
/** @param {string} id */
async function countAgentsInCategory(id) {
    await initDB();
    const row = await getOne('SELECT COUNT(*)::int AS n FROM agents WHERE category_id = $1', [id]);
    return row?.n || 0;
}

/** @param {string} id */
async function getAgentCategory(id) {
    await initDB();
    return getOne('SELECT * FROM agent_categories WHERE id = $1', [id]);
}

// Case-insensitive duplicate lookup inside one org (NULL org = global bucket).
/**
 * @param {string | null | undefined} orgId
 * @param {string | null | undefined} name
 */
async function findAgentCategoryByName(orgId, name) {
    await initDB();
    return getOne(
        'SELECT * FROM agent_categories WHERE organization_id IS NOT DISTINCT FROM $1 AND LOWER(name) = LOWER($2)',
        [orgId || null, String(name || '').trim()]
    );
}

const CATEGORY_COLUMNS = {
    name: { col: 'name', transform: (/** @type {unknown} */ v) => String(v).trim() },
    icon: 'icon',
    color: 'color',
};

/**
 * @param {string} id
 * @param {{ name?: string, icon?: string, color?: string }} [opts]
 */
async function updateAgentCategory(id, { name, icon, color } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'agent_categories',
        updates: { name, icon, color },
        columnMap: CATEGORY_COLUMNS,
        where: [{ col: 'id', value: id }],
    });
    if (!built) return getAgentCategory(id);
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0 ? getAgentCategory(id) : null;
}

// Move every agent in `fromId` to `toId` (null = uncategorise). Bumps `rev`
// so open editors reconcile via the existing 409 flow instead of silently
// clobbering (same precedent as transferAgentOwner).
/**
 * @param {string} fromId
 * @param {string | null | undefined} toId
 */
async function reassignAgentsCategory(fromId, toId = null) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE agents SET category_id = $2, rev = rev + 1, updated_at = NOW() WHERE category_id = $1',
        [fromId, toId]
    );
    return rowCount;
}

// `orgId` (when provided) scopes the delete to that org — the old
// unscoped delete let any manage_agents holder remove another org's category
// by id. Pass undefined only for super-admin callers.
/**
 * @param {string} id
 * @param {string | null | undefined} orgId
 */
async function deleteAgentCategory(id, orgId = undefined) {
    await initDB();
    // Unset category_id on agents that use this category
    await run('UPDATE agents SET category_id = NULL WHERE category_id = $1', [id]);
    const { rowCount } = orgId === undefined
        ? await run('DELETE FROM agent_categories WHERE id = $1', [id])
        : await run('DELETE FROM agent_categories WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2', [id, orgId || null]);
    return rowCount > 0;
}

module.exports = { getAgentCategories, createAgentCategory, countAgentsInCategory, getAgentCategory, findAgentCategoryByName, updateAgentCategory, reassignAgentsCategory, deleteAgentCategory };
