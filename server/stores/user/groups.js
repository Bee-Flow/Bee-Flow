// @typecheck
// Groups — org group CRUD, Azure AD lookups, and the default-groups seed.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const log = require('../../telemetry/log');

// ── Groups ─────────────────────────────
async function getAllGroups() {
    await initDB();
    const rows = await getAll('SELECT * FROM groups');
    return rows.map(g => ({
        ...g,
        permissions: parseJSON(g.permissions, []),
        roles: parseJSON(g.roles, []),
        allowedAgentTypes: parseJSON(g.allowedAgentTypes, []),
        allowedTiers: parseJSON(g.allowedTiers, []),
        disabled_integrations: parseJSON(g.disabled_integrations, []),
        granted_capabilities: parseJSON(g.granted_capabilities, []),
    }));
}

/**
 * One group by id — the targeted read `getAllGroups()` was standing in for.
 *
 * Callers that need a single group (the "Test as \u00b7 group X" simulation in
 * the agent editor) were otherwise pulling every group in the installation and
 * filtering in JS. Returns null when there is no such row; JSON columns are
 * parsed exactly as `getAllGroups` parses them so the two can never disagree
 * about a group's shape.
 */
async function getGroup(groupId) {
    await initDB();
    if (typeof groupId !== 'string' || !groupId) return null;
    const g = await getOne('SELECT * FROM groups WHERE id = $1', [groupId]);
    if (!g) return null;
    return {
        ...g,
        permissions: parseJSON(g.permissions, []),
        roles: parseJSON(g.roles, []),
        allowedAgentTypes: parseJSON(g.allowedAgentTypes, []),
        allowedTiers: parseJSON(g.allowedTiers, []),
        disabled_integrations: parseJSON(g.disabled_integrations, []),
        granted_capabilities: parseJSON(g.granted_capabilities, []),
    };
}

async function createGroup(groupData) {
    await initDB();
    const { id, organizationId, name, description, permissions, roles, allowedAgentTypes, azureGroupId, source, lastSyncedAt, orgRole } = groupData;
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
    if (ex) return false;
    try {
        // Default groups to orgRole='member' so freshly-mirrored groups
        // immediately have a sensible role baseline. The legacy default of
        // '' meant org-admins had to manually pick a role for every synced
        // group before users in those groups could do anything.
        await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount", "allowedAgentTypes", "azureGroupId", "source", "lastSyncedAt", "orgRole") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [id, organizationId || null, name, description || '', JSON.stringify(permissions || []), JSON.stringify(roles || []), 0, JSON.stringify(allowedAgentTypes || []), azureGroupId || null, source || 'manual', lastSyncedAt || null, orgRole || 'member']);
        return true;
    } catch (e) { log.error(e); return false; }
}

async function updateGroup(groupId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [groupId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', azureGroupId: 'azureGroupId', source: 'source', lastSyncedAt: 'lastSyncedAt', orgRole: 'orgRole' };
    const updateMap = {};
    for (const k of Object.keys(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.organizationId !== undefined) updateMap.organizationId = updates.organizationId;
    if (updates.permissions !== undefined) updateMap.permissions = JSON.stringify(updates.permissions);
    if (updates.roles !== undefined) updateMap.roles = JSON.stringify(updates.roles);
    if (updates.allowedAgentTypes !== undefined) updateMap.allowedAgentTypes = JSON.stringify(updates.allowedAgentTypes);
    if (updates.allowedTiers !== undefined) updateMap.allowedTiers = JSON.stringify(updates.allowedTiers);
    if (updates.disabledIntegrations !== undefined) updateMap.disabledIntegrations = JSON.stringify(updates.disabledIntegrations);
    if (updates.grantedCapabilities !== undefined) updateMap.grantedCapabilities = JSON.stringify(updates.grantedCapabilities);
    const fullColMap = { ...colMap, organizationId: 'organizationId', permissions: 'permissions', roles: 'roles', allowedAgentTypes: 'allowedAgentTypes', allowedTiers: 'allowedTiers', disabledIntegrations: 'disabled_integrations', grantedCapabilities: 'granted_capabilities' };
    try {
        const q = dynamicUpdate('groups', groupId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { log.error(e); return false; }
}

async function deleteGroup(groupId) {
    await initDB();

    // Phase 7b: Replace 3 full-table-scan + JS loops with targeted SQL UPDATEs.
    //
    // Old approach: SELECT * FROM table → JS loop → N individual UPDATE round-trips
    // New approach: single UPDATE per table using chained REPLACE on the JSON text.
    //
    // Four REPLACE passes handle all comma-adjacency edge cases:
    //   ["a","b","c"] → delete "b" → "a","c" → ["a","c"]   (middle: fix ,,)
    //   ["a","b"]     → delete "a" → ,"b"    → ["b"]        (first: fix [,)
    //   ["a","b"]     → delete "b" → "a",    → ["a"]        (last: fix ,])
    //   ["a"]         → delete "a" → ""      → []           (only: ,] + [, both clean)

    const entry = `"${groupId}"`;       // e.g. "admins"
    const like  = `%"${groupId}"%`;     // LIKE filter — only update rows that contain it

    const replaceChain = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col}, $1, ''), ',,', ','), ',]', ']'), '[,', '[')`;

    // Remove groupId from users.groups
    await run(`UPDATE users SET groups = ${replaceChain('groups')} WHERE groups LIKE $2`, [entry, like]);

    // Remove groupId from agents.shared_groups
    await run(`UPDATE agents SET shared_groups = ${replaceChain('shared_groups')} WHERE shared_groups LIKE $2`, [entry, like]);

    // Remove groupId from organizations.defaultGroups
    await run(`UPDATE organizations SET "defaultGroups" = ${replaceChain('"defaultGroups"')} WHERE "defaultGroups" LIKE $2`, [entry, like]);

    // Drop project shares targeting this group.
    //
    // project_shares.shared_with_id has no FK, so these rows outlive the group.
    // Group ids are CALLER-SUPPLIED, not generated, so recreating a group with a
    // previously-used id would silently re-grant its new members access to every
    // project the old group could see. (The org-delete path claims "group shares
    // targeting this org's groups are wiped by the groups DELETE above" — that
    // comment was wrong; the DELETE cascades nothing here.)
    try {
        await run(`DELETE FROM project_shares WHERE shared_with_type = 'group' AND shared_with_id = $1`, [groupId]);
    } catch (e) { /* table may not exist yet on a fresh install */ }

    const { rowCount } = await run('DELETE FROM groups WHERE id = $1', [groupId]);
    return rowCount > 0;
}

// ── Azure AD Lookup Helpers ─────────────────────────────
async function getGroupByAzureId(azureGroupId) {
    await initDB();
    return await getOne('SELECT * FROM groups WHERE "azureGroupId" = $1', [azureGroupId]);
}

async function getUserByAzureId(azureUserId) {
    await initDB();
    const row = await getOne('SELECT * FROM users WHERE "azureUserId" = $1', [azureUserId]);
    if (!row) return null;
    return { ...row, groups: parseJSON(row.groups, []) };
}

async function initDefaultGroups() {
    await initDB();
    if (!(await getOne('SELECT id FROM groups WHERE id = $1', ['admins']))) await createGroup({ id: 'admins', name: 'Administrators', description: 'Full system access', permissions: ['all'] });
    if (!(await getOne('SELECT id FROM groups WHERE id = $1', ['users']))) await createGroup({ id: 'users', name: 'Users', description: 'Standard user access', permissions: ['read', 'chat'] });
}
initDefaultGroups().catch(err => log.error('[UserStore] initDefaultGroups error:', err.message));

module.exports = {
    getAllGroups, getGroup, createGroup, updateGroup, deleteGroup, getGroupByAzureId, getUserByAzureId,
};
