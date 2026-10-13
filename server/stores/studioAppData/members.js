// @typecheck
/**
 * App membership and roles (the RLS input). The studio_app_members PK has no
 * owner column, so every owner mutation is gated by ownsApp.
 */

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { mapMemberRow } = require('./rowMappers');

/** Ownership gate for the ownerless studio_app_members PK. */
async function ownsApp(appId, ownerId) {
    if (!appId || !ownerId) return false;
    const r = await getOne(`SELECT 1 FROM studio_apps WHERE id = $1 AND user_id = $2`, [appId, ownerId]);
    return !!r;
}

// ── Members ─────────────────────────────────────────────────────────

/** Add or re-role a member. Owner-gated via ownsApp (the PK has no owner col). */
async function addMember(appId, ownerId, memberUserId, roleKey = 'member') {
    await initDB();
    if (!(await ownsApp(appId, ownerId))) return null;
    const existing = await getOne(
        `SELECT app_id FROM studio_app_members WHERE app_id = $1 AND user_id = $2`, [appId, memberUserId]
    );
    if (existing) {
        const row = await getOne(
            `UPDATE studio_app_members SET role_key = $1, updated_at = NOW()
             WHERE app_id = $2 AND user_id = $3 RETURNING *`,
            [roleKey || 'member', appId, memberUserId]
        );
        return row ? mapMemberRow(row) : null;
    }
    const row = await getOne(
        `INSERT INTO studio_app_members (app_id, user_id, role_key) VALUES ($1, $2, $3) RETURNING *`,
        [appId, memberUserId, roleKey || 'member']
    );
    return row ? mapMemberRow(row) : null;
}

/** Members of an app — owner-gated. */
async function listMembers(appId, ownerId) {
    await initDB();
    if (!(await ownsApp(appId, ownerId))) return [];
    const rows = await getAll(
        `SELECT * FROM studio_app_members WHERE app_id = $1 ORDER BY created_at ASC`, [appId]
    );
    return rows.map(mapMemberRow);
}

async function removeMember(appId, ownerId, memberUserId) {
    await initDB();
    if (!(await ownsApp(appId, ownerId))) return false;
    await run(`DELETE FROM studio_app_members WHERE app_id = $1 AND user_id = $2`, [appId, memberUserId]);
    return true;
}

/**
 * A viewer's own role in an app. Deliberately NOT owner-scoped — this is the
 * RLS gateway resolving the caller's own membership, not an owner mutating
 * someone else's. Returns the role_key or null.
 */
async function getMemberRole(appId, userId) {
    await initDB();
    const r = await getOne(
        `SELECT role_key FROM studio_app_members WHERE app_id = $1 AND user_id = $2`, [appId, userId]
    );
    return r ? r.role_key : null;
}

module.exports = { addMember, listMembers, removeMember, getMemberRole };
