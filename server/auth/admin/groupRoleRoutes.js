// @typecheck
/**
 * Admin Routes — group and role management, plus the SYSTEM_PERMISSIONS
 * catalogue. Split out of auth/adminRoutes.js; mounted there in the original
 * registration order.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
// `resolveUserOrgIds` is imported by name alongside the rest, exactly as
// orgRoutes/userRoutes/featureAccessRoutes do. It was used below without being
// imported, so GET /auth/groups threw a ReferenceError for every non-super-admin
// — a 500 where the org-scoped group list should have been. That fails closed
// rather than leaking other tenants' groups, but it left the sharing pickers
// that read this endpoint permanently empty.
const { requireAuth, requireAdmin, requireSuperAdmin, requirePrimaryOrgAdmin, getUserPermissions, invalidateAllPermissionCaches, resolveUserOrgIds, SYSTEM_PERMISSIONS, getOrgRolePermissions } = require('../permissions');
const orgRolePolicy = require('../orgRolePolicy');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// The `roles` table has no organizationId column — a role is install-wide, so
// editing one reshapes permissions for every tenant. That makes role mutation
// platform scope, and it also closes an escalation ladder: POST /roles took
// `permissions` verbatim from the body with no allow-list, so an org admin
// could mint a role carrying 'all', attach it to a group in their own org, and
// have getUserPermissions() resolve them to ['all'] — clearing every gate that
// honours that wildcard. Reads stay open (the org users panel needs the list to
// render its role dropdown); only the mutating verbs are operator-only.
const SYSTEM_ROLE_IDS = new Set(['admin', 'user']);

// === Group Management API (Admin Only) ===

router.get('/groups', requireAuth, async (req, res) => {
    // Non-super-admins must have group management permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isSuperAdmin) {
        const userId = req.session.user?.id;
        const perms = await getUserPermissions(userId, req.session);
        const canView = perms.includes('all') || perms.includes('manage_users') || perms.includes('admin_security') || perms.includes('org_admin');
        if (!canView) {
            return res.status(403).json({ error: 'Permission required to view groups' });
        }
    }

    let groups = await userStore.getAllGroups();

    // Org-scoped filtering using canonical resolver
    if (!isSuperAdmin) {
        const myOrgIds = await resolveUserOrgIds(req);
        if (myOrgIds) {
            groups = groups.filter(g => g.organizationId && myOrgIds.has(g.organizationId));
        }
    }

    res.json(groups);
});

/**
 * `permissions` and `roles` are string arrays everywhere they are READ:
 * getUserPermissions iterates them element by element (permissions.js ~:495), so
 * a string is walked character by character and an object is not walked at all,
 * and every admin UI renders them as lists. Nothing validated the type on the
 * way in, so PUT /groups/:id {"roles":"admin"} stored the string verbatim and
 * left the row in a shape no reader expects. rejectUngrantableRoles cannot
 * catch it either — its `if (!Array.isArray(requested)) return null` bails out
 * before the escalation check, which is safe (no role id matches) but silent.
 * Reject the wrong type at the edge, for super-admins too: this is a request
 * shape error, not a privilege question.
 *
 * `undefined`/`null` means "field not supplied" and stays the caller's business.
 *
 * @returns {string|null} an error message, or null when the value is acceptable
 */
function invalidStringArrayField(value, field) {
    // ONLY undefined means "field not supplied". null is supplied — and
    // userStore.updateGroup keys on `!== undefined`, so {"roles": null} was
    // reaching JSON.stringify and writing the literal `null` into groups.roles,
    // which getUserPermissions then tries to iterate. Clearing a list is [].
    if (value === undefined) return null;
    if (value === null) return `${field} must be an array (use [] to clear it, not null)`;
    if (!Array.isArray(value)) return `${field} must be an array`;
    if (value.some((v) => typeof v !== 'string')) return `${field} must be an array of strings`;
    return null;
}

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

    const blocked = [];
    for (const rid of added) {
        const role = roleMap[rid];
        if (!role) {
            // An id with no role behind it grants nothing today, but roles are
            // global and a later role with that id would silently activate it.
            blocked.push(`${rid} (unknown role)`);
            continue;
        }
        const missing = (role.permissions || []).filter((p) => !userPerms.includes(p));
        if (missing.length > 0) blocked.push(`${rid} (grants: ${missing.join(', ')})`);
    }
    if (blocked.length === 0) return null;
    return `Cannot assign roles that grant permissions you don't have: ${blocked.join('; ')}`;
}

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/**
 * The list shape as a schema, delegating to invalidStringArrayField so the one
 * definition above stays the only place that decides what a list field may be
 * — including that `null` is supplied-but-wrong and says to use [] instead.
 */
const idList = (field) => z.any().superRefine((value, ctx) => {
    const message = invalidStringArrayField(value, field);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}).optional();

const GROUP_NAME_TEXT = 'Group name required';
const ROLE_NAME_TEXT = 'Role name required';

/**
 * Groups and roles carry PERMISSIONS, and neither of these bodies refused a
 * key it did not recognise: `{"permisions": ["all"]}` was answered 200
 * {"success":true} with nothing changed. PUT /users/:id closed exactly this
 * after a pentest — "a report of success for a privilege change that did not
 * happen is how a real escalation gets mistaken for a failed one" — and the
 * objects that DEFINE the privileges were left open.
 *
 * The permission and role IDS are deliberately not enumerated here: they are
 * installation-defined (SYSTEM_PERMISSIONS plus whatever roles the deployment
 * created) and the handlers already refuse any the caller cannot grant, which
 * is the check that matters.
 */
const CreateGroupBody = z.object({
    name: worded(GROUP_NAME_TEXT).trim().min(1, GROUP_NAME_TEXT).max(200, 'A group name is at most 200 characters.'),
    description: worded('A description must be text.').max(2000, 'That description is too long.').optional(),
    permissions: idList('permissions'),
    roles: idList('roles'),
    organizationId: worded('An organization id must be text.').trim().max(200, 'That organization id is too long.').nullable().optional(),
    allowedAgentTypes: idList('allowedAgentTypes'),
}).strict();

const UpdateGroupBody = z.object({
    description: worded('A description must be text.').max(2000, 'That description is too long.').optional(),
    permissions: idList('permissions'),
    roles: idList('roles'),
    organizationId: worded('An organization id must be text.').trim().max(200, 'That organization id is too long.').nullable().optional(),
    allowedAgentTypes: idList('allowedAgentTypes'),
    allowedTiers: idList('allowedTiers'),
    orgRole: worded('An organisation role must be text.').max(64, 'That organisation role is too long.').nullable().optional(),
}).strict();

const MEMBER_TEXT = 'userId required';
const GroupMemberBody = z.object({
    userId: worded(MEMBER_TEXT).trim().min(1, MEMBER_TEXT).max(200, MEMBER_TEXT),
}).strict();

const CreateRoleBody = z.object({
    name: worded(ROLE_NAME_TEXT).trim().min(1, ROLE_NAME_TEXT).max(200, 'A role name is at most 200 characters.'),
    description: worded('A description must be text.').max(2000, 'That description is too long.').optional(),
    permissions: idList('permissions'),
}).strict();

const UpdateRoleBody = z.object({
    name: worded('A role name must be text.').trim().min(1, 'A role name cannot be blank.').max(200, 'A role name is at most 200 characters.').optional(),
    description: worded('A description must be text.').max(2000, 'That description is too long.').optional(),
    permissions: idList('permissions'),
}).strict();

const PERMISSIONS_TEXT = 'permissions must be an array';
const OrgRolePermissionsBody = z.object({
    permissions: z.array(worded(PERMISSIONS_TEXT), { required_error: PERMISSIONS_TEXT, invalid_type_error: PERMISSIONS_TEXT }),
}).strict();

router.post('/groups', requireAuth, validate({ body: CreateGroupBody }), async (req, res) => {
    const { name, description, permissions, roles, organizationId, allowedAgentTypes } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Group name required' });
    }

    // Require org_admin or manage_users permission to create groups
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const userId = req.session.user?.id;
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            return res.status(403).json({ error: 'Organisation admin access required to manage groups' });
        }
    }

    // For non-super-admins, force the group into their org
    let orgId = organizationId || null;
    if (!isSuperAdmin) {
        const currentUser = await userStore.getUser(userId);
        if (!currentUser?.organizationId) {
            return res.status(403).json({ error: 'You must belong to an organisation to create groups' });
        }
        orgId = currentUser.organizationId;

        // Validate permissions — users can only grant permissions they possess
        if (permissions && permissions.length > 0) {
            const userPerms = await getUserPermissions(userId, req.session);
            if (!userPerms.includes('all')) {
                const unauthorized = permissions.filter(p => !userPerms.includes(p));
                if (unauthorized.length > 0) {
                    return res.status(403).json({ error: `Cannot assign permissions you don't have: ${unauthorized.join(', ')}` });
                }
            }
        }

        // Same rule for roles, which expand into permissions for every member.
        const roleError = await rejectUngrantableRoles({ userId, session: req.session, requested: roles, existing: [] });
        if (roleError) return res.status(403).json({ error: roleError });
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newGroup = {
        id,
        organizationId: orgId,
        name,
        description: description || '',
        permissions: permissions || [],
        roles: roles || [],
        allowedAgentTypes: allowedAgentTypes || []
    };

    if (await userStore.createGroup(newGroup)) {
        log.info(`[Audit] ${userId || 'system'} created group '${name}' (${id}) in org '${orgId || 'global'}'`);
        await userStore.logAccessAudit(
            'group.create',
            'group',
            id,
            userId || null,
            null,
            { name, permissions: newGroup.permissions, roles: newGroup.roles, allowedAgentTypes: newGroup.allowedAgentTypes },
            orgId,
        );
        res.json({ success: true, group: newGroup });
    } else {
        res.status(400).json({ error: 'Group already exists' });
    }
});

router.put('/groups/:id', requireAuth, validate({ body: UpdateGroupBody }), async (req, res) => {
    const { id } = req.params;
    const { description, permissions, roles, organizationId, allowedAgentTypes, allowedTiers, orgRole } = req.body;

    // Require org_admin or manage_users permission to edit groups
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const userId = req.session.user?.id;
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            return res.status(403).json({ error: 'Organisation admin access required to manage groups' });
        }

        const currentUser = await userStore.getUser(userId);
        const allGroups = await userStore.getAllGroups();
        const group = allGroups.find(g => g.id === id);
        if (!group || !currentUser?.organizationId || group.organizationId !== currentUser.organizationId) {
            return res.status(403).json({ error: 'You can only edit groups in your organisation' });
        }

        // Validate permissions — users can only grant permissions they possess
        if (permissions && permissions.length > 0) {
            const userPerms = await getUserPermissions(userId, req.session);
            if (!userPerms.includes('all')) {
                const unauthorized = permissions.filter(p => !userPerms.includes(p));
                if (unauthorized.length > 0) {
                    return res.status(403).json({ error: `Cannot assign permissions you don't have: ${unauthorized.join(', ')}` });
                }
            }
        }

        // Same rule for roles. Only additions are checked, so re-saving a group
        // that already carries a super-admin-attached role still works.
        const roleError = await rejectUngrantableRoles({
            userId, session: req.session, requested: roles, existing: group.roles || [],
        });
        if (roleError) return res.status(403).json({ error: roleError });
    }

    const updates = { description, permissions, roles };
    // Only super admins can reassign a group to a different org
    if (organizationId !== undefined && isSuperAdmin) {
        updates.organizationId = organizationId;
    }
    if (allowedAgentTypes !== undefined) {
        updates.allowedAgentTypes = allowedAgentTypes;
    }
    if (allowedTiers !== undefined) {
        updates.allowedTiers = allowedTiers;
    }
    if (orgRole !== undefined) {
        updates.orgRole = orgRole;
    }

    // Snapshot the group so the audit row carries the before/after of the
    // access-relevant fields, not just the new state.
    let prevGroup = null;
    try {
        const all = await userStore.getAllGroups();
        prevGroup = all.find(g => g.id === id) || null;
    } catch (_) { prevGroup = null; }

    if (await userStore.updateGroup(id, updates)) {
        log.info(`[Audit] ${userId || 'system'} updated group '${id}' — fields: ${Object.keys(updates).filter(k => updates[k] !== undefined).join(', ')}`);
        const AUDIT_FIELDS = ['permissions', 'roles', 'orgRole', 'allowedAgentTypes', 'allowedTiers', 'organizationId'];
        const oldVals = {};
        const newVals = {};
        for (const f of AUDIT_FIELDS) {
            if (updates[f] === undefined) continue;
            if (prevGroup && JSON.stringify(prevGroup[f]) === JSON.stringify(updates[f])) continue;
            oldVals[f] = prevGroup ? prevGroup[f] : null;
            newVals[f] = updates[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'group.update',
                'group',
                id,
                userId || null,
                oldVals,
                newVals,
                (prevGroup && prevGroup.organizationId) || updates.organizationId || null,
            );
        }
        // Permissions / roles / orgRole on the group change the effective
        // permission set of every member. Easiest safe bet: clear all.
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Group not found' });
    }
});

// Reciprocal group→user membership management (BFSF-219). The forward
// user→group flow already existed (PUT /auth/users/:id with a `groups` array
// from the Users tab); this lets an admin add/remove members directly from the
// group view. Membership lives on the user's `groups` array, so we update the
// target user. Same permission model + same-org guard as editing the group.
async function assertCanManageGroupMembers(req, res, groupId) {
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const adminId = req.session.user?.id;
    const allGroups = await userStore.getAllGroups();
    const group = allGroups.find(g => g.id === groupId);
    if (!group) { res.status(404).json({ error: 'Group not found' }); return null; }
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(adminId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            res.status(403).json({ error: 'Organisation admin access required to manage group members' });
            return null;
        }
        const currentUser = await userStore.getUser(adminId);
        if (!currentUser?.organizationId || group.organizationId !== currentUser.organizationId) {
            res.status(403).json({ error: 'You can only manage groups in your organisation' });
            return null;
        }
    }
    return { group, adminId, isSuperAdmin };
}

router.post('/groups/:id/members', requireAuth, validate({ body: GroupMemberBody }), async (req, res) => {
    const { id } = req.params;
    const targetUserId = req.body.userId;
    const ctx = await assertCanManageGroupMembers(req, res, id);
    if (!ctx) return;
    const target = await userStore.getUser(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (!ctx.isSuperAdmin && target.organizationId !== ctx.group.organizationId) {
        return res.status(403).json({ error: 'User is not in this organisation' });
    }
    const groups = Array.isArray(target.groups) ? target.groups : [];
    if (groups.includes(id)) return res.json({ success: true, alreadyMember: true });
    if (!await userStore.updateUser(targetUserId, { groups: [...groups, id] })) {
        return res.status(500).json({ error: 'Failed to add member' });
    }
    await userStore.logAccessAudit('group.member.add', 'group', id, ctx.adminId || null, null, { userId: targetUserId }, ctx.group.organizationId || null);
    try { await invalidateAllPermissionCaches(); } catch (_) { /* best-effort */ }
    res.json({ success: true });
});

router.delete('/groups/:id/members/:userId', requireAuth, async (req, res) => {
    const { id, userId: targetUserId } = req.params;
    const ctx = await assertCanManageGroupMembers(req, res, id);
    if (!ctx) return;
    const target = await userStore.getUser(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const groups = Array.isArray(target.groups) ? target.groups : [];
    if (!groups.includes(id)) return res.json({ success: true, notMember: true });
    if (!await userStore.updateUser(targetUserId, { groups: groups.filter(g => g !== id) })) {
        return res.status(500).json({ error: 'Failed to remove member' });
    }
    await userStore.logAccessAudit('group.member.remove', 'group', id, ctx.adminId || null, { userId: targetUserId }, null, ctx.group.organizationId || null);
    try { await invalidateAllPermissionCaches(); } catch (_) { /* best-effort */ }
    res.json({ success: true });
});

router.delete('/groups/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (id === 'admins' || id === 'users') {
        return res.status(400).json({ error: 'Cannot delete system groups' });
    }

    // Require org_admin or manage_users permission to delete groups
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const userId = req.session.user?.id;
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            return res.status(403).json({ error: 'Organisation admin access required to manage groups' });
        }

        const currentUser = await userStore.getUser(userId);
        const allGroups = await userStore.getAllGroups();
        const group = allGroups.find(g => g.id === id);
        if (!group || !currentUser?.organizationId || group.organizationId !== currentUser.organizationId) {
            return res.status(403).json({ error: 'You can only delete groups in your organisation' });
        }
    }

    // Snapshot before destructive delete so the audit trail records what was
    // removed (the row is gone after deleteGroup).
    let prevGroup = null;
    try {
        const all = await userStore.getAllGroups();
        prevGroup = all.find(g => g.id === id) || null;
    } catch (_) { prevGroup = null; }

    if (await userStore.deleteGroup(id)) {
        log.info(`[Audit] ${userId || 'system'} deleted group '${id}'`);
        await userStore.logAccessAudit(
            'group.delete',
            'group',
            id,
            userId || null,
            prevGroup ? {
                name: prevGroup.name,
                permissions: prevGroup.permissions,
                roles: prevGroup.roles,
                orgRole: prevGroup.orgRole,
                organizationId: prevGroup.organizationId,
            } : null,
            null,
            prevGroup ? prevGroup.organizationId : null,
        );
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Group not found' });
    }
});


// === Roles Management API (Admin Only) ===

// DELIBERATELY not requireSuperAdmin, unlike the POST/PUT/DELETE below.
// OrgUsersPanel (an org-admin surface) fetches this to populate its role
// dropdown, so tightening it would break user management for every org admin.
// The list is role names and permission ids — no tenant data.
router.get('/roles', requireAdmin, async (req, res) => {
    const roles = await userStore.getAllRoles();
    res.json(roles);
});

router.post('/roles', requireSuperAdmin, validate({ body: CreateRoleBody }), async (req, res) => {
    const { name, description, permissions } = req.body;
    // Creating a role whose id collides with a system role would silently
    // redefine it, since createRole keys on the slugified name.
    const candidateId = name.toLowerCase().replace(/\s+/g, '-');
    if (SYSTEM_ROLE_IDS.has(candidateId)) {
        return res.status(400).json({ error: 'Cannot redefine a system role' });
    }

    const id = name.toLowerCase().replace(/\s+/g, '-');
    const newRole = {
        id,
        name,
        description: description || '',
        permissions: permissions || []
    };

    if (await userStore.createRole(newRole)) {
        log.info(`[Audit] ${req.session.user?.id || 'system'} created role '${name}' (${id})`);
        await userStore.logAccessAudit(
            'role.create',
            'role',
            id,
            req.session.user?.id || null,
            null,
            { name, description: newRole.description, permissions: newRole.permissions },
            null,
        );
        res.json({ success: true, role: newRole });
    } else {
        res.status(400).json({ error: 'Role already exists' });
    }
});

router.put('/roles/:id', requireSuperAdmin, validate({ body: UpdateRoleBody }), async (req, res) => {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    // DELETE has guarded the system roles since forever; PUT did not, so the
    // 'user' role — which every account resolves through — could be rewritten
    // to ['all'] and hand the whole install to everyone.
    if (SYSTEM_ROLE_IDS.has(id)) {
        return res.status(400).json({ error: 'Cannot modify system roles' });
    }

    let prevRole = null;
    try {
        const all = await userStore.getAllRoles();
        prevRole = all.find(r => r.id === id) || null;
    } catch (_) { prevRole = null; }

    if (await userStore.updateRole(id, { name, description, permissions })) {
        const AUDIT_FIELDS = ['name', 'description', 'permissions'];
        const oldVals = {};
        const newVals = {};
        const incoming = { name, description, permissions };
        for (const f of AUDIT_FIELDS) {
            if (incoming[f] === undefined) continue;
            if (prevRole && JSON.stringify(prevRole[f]) === JSON.stringify(incoming[f])) continue;
            oldVals[f] = prevRole ? prevRole[f] : null;
            newVals[f] = incoming[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'role.update',
                'role',
                id,
                req.session.user?.id || null,
                oldVals,
                newVals,
                null,
            );
        }
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Role not found' });
    }
});

router.delete('/roles/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    if (SYSTEM_ROLE_IDS.has(id)) {
        return res.status(400).json({ error: 'Cannot delete system roles' });
    }

    let prevRole = null;
    try {
        const all = await userStore.getAllRoles();
        prevRole = all.find(r => r.id === id) || null;
    } catch (_) { prevRole = null; }

    if (await userStore.deleteRole(id)) {
        log.info(`[Audit] ${req.session.user?.id || 'system'} deleted role '${id}'`);
        await userStore.logAccessAudit(
            'role.delete',
            'role',
            id,
            req.session.user?.id || null,
            prevRole,
            null,
            null,
        );
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Role not found' });
    }
});


// === Organisation roles API ===

/**
 * The orgRole → permission-id mapping the permission resolver actually applies
 * (server/config/orgRoles.json).
 *
 * It exists so the Organisation Roles screen can SHOW what a role grants
 * instead of describing it. That screen used to render a hand-written list in
 * the frontend's own config, which had drifted: it credited the Organisation
 * Admin with five permissions out of twenty-odd and mentioned no Studio section
 * at all, so the one page that answers "who in my organisation can use this"
 * answered it wrongly.
 *
 * Same audience and same reasoning as GET /roles above — an org admin needs it
 * to render their own roles page, and the payload is role ids and permission
 * ids, no tenant data.
 */
router.get('/org-roles', requireAdmin, async (req, res) => {
    // The CALLER's org, so an org admin sees what their own organisation
    // decided rather than the shipped defaults. Super admins with no org of
    // their own fall through to the defaults, which is what they administer.
    const orgId = req.session?.user?.organizationId
        || (await userStore.getUser(req.session?.user?.id).catch(() => null))?.organizationId
        || null;
    const mapping = await orgRolePolicy.resolveOrgRolePermissions(orgId, getOrgRolePermissions());
    res.json({
        roles: Object.entries(mapping).map(([id, permissions]) => ({ id, permissions })),
        // Which of them this screen may actually change. Sent rather than
        // hardcoded in the client so the two can never disagree about what a
        // PUT will accept.
        editablePermissions: orgRolePolicy.EDITABLE_PERMISSIONS,
    });
});

/**
 * PUT /org-roles/:roleId — the organisation's choice for one role.
 *
 * Body: { permissions: string[] } — the FULL set of editable permissions that
 * role should carry, not a delta. Anything outside EDITABLE_PERMISSIONS is
 * dropped rather than refused: the client sends what it rendered, and a
 * permission it may not change is not an error, it is simply not the client's
 * to send. Everything else the shipped role carries is untouched.
 *
 * Org-admin scope, on the caller's OWN org (requirePrimaryOrgAdmin attaches
 * req.primaryOrgId). Unlike POST /roles above there is no escalation ladder to
 * guard: the editable set contains no permission that raises anyone's
 * privileges over the organisation — see the header of auth/orgRolePolicy.js.
 */
router.put('/org-roles/:roleId', requirePrimaryOrgAdmin(), validate({ body: OrgRolePermissionsBody }), async (req, res) => {
    const roleId = String(req.params.roleId || '');
    const known = getOrgRolePermissions();
    if (!Object.prototype.hasOwnProperty.call(known, roleId)) {
        return res.status(404).json({ error: 'Unknown organisation role' });
    }
    try {
        const stored = await orgRolePolicy.setOrgRolePermissions(
            req.primaryOrgId, roleId, req.body.permissions,
        );
        // Every member of this org may have just gained or lost a section.
        // Their resolved permissions are cached per user, so the whole cache
        // goes rather than trying to enumerate who holds the role.
        invalidateAllPermissionCaches();
        log.info(`[Audit] ${req.session.user?.id || 'system'} set org ${req.primaryOrgId} role '${roleId}' permissions: ${stored.join(', ') || '(none)'}`);
        await userStore.logAccessAudit(
            'org_role.permissions.update', 'org_role', `${req.primaryOrgId}:${roleId}`,
            req.session.user?.id || null, null, { permissions: stored }, null,
        ).catch(() => { });
        res.json({ id: roleId, permissions: stored });
    } catch (e) {
        log.error('[OrgRoles] update failed:', e.message);
        res.status(500).json({ error: 'Failed to save role permissions' });
    }
});

// === Permissions API ===

// Static SYSTEM_PERMISSIONS catalogue — no tenant data, and the org-admin
// permission editor needs it. Kept readable for the same reason as GET /roles.
router.get('/permissions', requireAdmin, async (req, res) => {
    res.json(SYSTEM_PERMISSIONS);
});

module.exports = router;
