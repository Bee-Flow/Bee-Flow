// @typecheck strict
/**
 * "You cannot grant a permission you don't hold" for a group's `roles` and
 * its `orgRole`: the checks PUT/POST /groups (./groupRoleRoutes.js) run before
 * a group is written.
 */

const userStore = require('../../stores/userStore');
const { getUserPermissions, getOrgRolePermissions } = require('../permissions');
const orgRolePolicy = require('../orgRolePolicy');

/**
 * "You cannot grant a permission you don't hold" — for ROLES.
 *
 * A group carries both a `permissions` array and a `roles` array, and
 * getUserPermissions expands the second into the first for every member
 * (permissions.js: group.roles → role.permissions, then a short-circuit to
 * ['all'] if the union contains 'all'). Only `permissions` was ever validated,
 * so a caller holding just `manage_users` could PUT {"roles":["admin"]} onto a
 * group in their own org — initDefaultRoles seeds role id 'admin' with
 * permissions ['all'], and roles are global, not org-scoped — then add
 * themselves to that group and come back holding the wildcard. That clears
 * requireAdmin, every requirePermission(...) gate and `admin_support` (Bee
 * Flow's own cross-tenant support inbox). Only requireSuperAdmin, which reads
 * users.role, still held.
 *
 * Only NEWLY ADDED role ids are validated: a group may already carry a role a
 * super-admin attached, and re-sending the unchanged array (which is what an
 * edit form does) must not lock an org admin out of editing that group.
 * Removing roles is always allowed.
 *
 * @param {{ userId: string | undefined, session: import('express').Request['session'], requested: unknown, existing?: string[] }} opts
 * @returns {Promise<string|null>} an error message, or null when the change is allowed
 */
async function rejectUngrantableRoles({ userId, session, requested, existing = [] }) {
    // Callers reject a non-array before they get here (invalidStringArrayField),
    // so this only guards direct/internal use: a non-array cannot be diffed
    // against `existing`, and no element of it can match a role id.
    if (!Array.isArray(requested)) return null;
    const have = new Set(Array.isArray(existing) ? existing : []);
    const added = requested.filter((r) => !have.has(r));
    if (added.length === 0) return null;

    const userPerms = await getUserPermissions(userId, session);
    if (userPerms.includes('all')) return null;

    const allRoles = await userStore.getAllRoles();
    const roleMap = Object.fromEntries((allRoles || []).map((r) => [r.id, r]));

    /** @type {string[]} */
    const blocked = [];
    for (const rid of added) {
        const role = roleMap[rid];
        if (!role) {
            // An id with no role behind it grants nothing today, but roles are
            // global and a later role with that id would silently activate it.
            blocked.push(`${rid} (unknown role)`);
            continue;
        }
        const missing = /** @type {string[]} */ (role.permissions || []).filter((p) => !userPerms.includes(p));
        if (missing.length > 0) blocked.push(`${rid} (grants: ${missing.join(', ')})`);
    }
    if (blocked.length === 0) return null;
    return `Cannot assign roles that grant permissions you don't have: ${blocked.join('; ')}`;
}

/**
 * The same rule for a group's `orgRole`, which every member also acts as
 * (getUserPermissions resolves it in the group's organisation). A NEW value may
 * only name a role whose permissions the caller holds; an unchanged value and
 * clearing it are always allowed.
 *
 * @param {{ userId: string | undefined, session: import('express').Request['session'], requested: unknown, existing?: unknown, orgId: string | null | undefined }} opts
 * @returns {Promise<string|null>} an error message, or null when the change is allowed
 */
async function rejectUngrantableOrgRole({ userId, session, requested, existing, orgId }) {
    if (requested === undefined || requested === null || requested === '') return null;
    if (String(requested) === String(existing ?? '')) return null;
    const userPerms = await getUserPermissions(userId, session);
    if (userPerms.includes('all')) return null;
    const role = requested === 'admin' ? 'org_admin' : String(requested);
    const byRole = await orgRolePolicy.resolveOrgRolePermissions(orgId || '', getOrgRolePermissions());
    /** @type {string[]} */
    const granted = Array.isArray(byRole?.[role]) ? byRole[role] : [];
    const missing = granted.filter((p) => !userPerms.includes(p));
    if (missing.length === 0) return null;
    return `Cannot assign an organisation role that grants permissions you don't have: ${role} (grants: ${missing.join(', ')})`;
}

module.exports = { rejectUngrantableRoles, rejectUngrantableOrgRole };
