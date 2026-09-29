// @typecheck
// Roles — role CRUD and the default-roles seed.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const log = require('../../telemetry/log');

// ── Roles ─────────────────────────────
async function getAllRoles() {
    await initDB();
    const rows = await getAll('SELECT * FROM roles');
    return rows.map(r => ({ ...r, permissions: parseJSON(r.permissions, []) }));
}

async function createRole(roleData) {
    await initDB();
    const { id, name, description, permissions } = roleData;
    const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
    if (ex) return false;
    try { await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)', [id, name, description || '', JSON.stringify(permissions || [])]); return true; } catch (e) { log.error(e); return false; }
}

async function updateRole(roleId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM roles WHERE id = $1', [roleId]);
    if (!ex) return false;
    const updateMap = {};
    if (updates.name !== undefined) updateMap.name = updates.name;
    if (updates.description !== undefined) updateMap.description = updates.description;
    if (updates.permissions !== undefined) updateMap.permissions = JSON.stringify(updates.permissions);
    const colMap = { name: 'name', description: 'description', permissions: 'permissions' };
    try { const q = dynamicUpdate('roles', roleId, updateMap, colMap); if (q) await run(q.sql, q.params); return true; } catch (e) { log.error(e); return false; }
}

async function deleteRole(roleId) { await initDB(); const { rowCount } = await run('DELETE FROM roles WHERE id = $1', [roleId]); return rowCount > 0; }

async function initDefaultRoles() {
    await initDB();
    const defaults = [
        { id: 'admin', name: 'Administrator', description: 'Full system access', permissions: ['all'] },
        { id: 'user', name: 'User', description: 'Standard user access', permissions: ['read', 'chat'] },
        { id: 'org_admin', name: 'Organisation Admin', description: 'Edit org settings, manage users/groups/permissions, set Privacy Shield, plus all agent permissions', permissions: ['org.manage', 'org.users', 'org.privacy_shield', 'agents.create', 'agents.edit_published', 'agents.edit_unpublished'] },
        { id: 'agent_admin', name: 'Agent Admin', description: 'Create and edit all published and unpublished agents', permissions: ['agents.create', 'agents.edit_published', 'agents.edit_unpublished'] },
        { id: 'agent_editor', name: 'Agent Editor', description: 'Create and edit all published agents', permissions: ['agents.create', 'agents.edit_published'] },
    ];
    for (const r of defaults) { if (!(await getOne('SELECT id FROM roles WHERE id = $1', [r.id]))) await createRole(r); }
}
initDefaultRoles().catch(err => log.error('[UserStore] initDefaultRoles error:', err.message));

module.exports = { getAllRoles, createRole, updateRole, deleteRole };
