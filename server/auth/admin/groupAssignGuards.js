// @typecheck strict
/**
 * Admin Routes: which organisations a user administers, and which groups a
 * caller may assign (to a user, or as an organisation's default groups).
 * Split out of orgAdminGuards.js, which re-exports every name here.
 */

const userStore = require('../../stores/userStore');
const permissions = require('../permissions');
const log = require('../../telemetry/log');

/**
 * @typedef {import('express').Request} Request
 */

/**
 * Every organisation this user can administer — not just the one in their
 * `organizationId` column.
 *
 * countOrgMembers counts an admin who belongs to an org only through one of its
 * GROUPS, because isOrgAdminForOrg lets that person administer it. Resolving the
 * guard's target org from `organizationId` alone therefore disagreed with the
 * counter in both directions: an admin whose primary org is orgB but who
 * administers orgA through a group could be demoted with only orgB's admin count
 * consulted, silently orphaning orgA; and an admin with no primary org at all
 * skipped the guard entirely. Ask the same question the counter answers.
 * @param {Record<string, any> | null | undefined} user
 * @returns {Promise<string[]>}
 */
async function orgsAdministeredBy(user) {
    if (!user || !permissions.isOrgAdminRole(user.orgRole)) return [];
    const orgIds = new Set();
    if (user.organizationId) orgIds.add(user.organizationId);
    /** @type {string[]} */
    let gids = [];
    try { gids = Array.isArray(user.groups) ? user.groups : JSON.parse(user.groups || '[]'); } catch (_) { gids = []; }
    if (gids.length) {
        try {
            const groups = await userStore.getAllGroups();
            for (const g of groups || []) {
                if (g?.organizationId && gids.includes(g.id)) orgIds.add(g.organizationId);
            }
        } catch (e) { log.warn('[adminRoutes] group lookup for org-admin guard failed:', /** @type {Error} */ (e).message); }
    }
    return [...orgIds];
}

/**
 * Tenant ids are compared, not just read, so `''`, `null` and `undefined` have to
 * collapse to one value first — otherwise "no organisation" spelled two ways
 * reads as a change and a plain profile edit starts 403ing.
 * @param {unknown} v
 */
function normaliseOrgId(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/**
 * The permissions a group hands its members: its own list, those of its roles,
 * and those its capability grants imply. A role id with no role behind it is
 * reported as `unknownRole` (a later role with that id would activate it).
 * @param {Record<string, any>} group
 * @param {Record<string, any>[]} allRoles
 * @returns {{ perms: Set<string>, unknownRole: boolean }}
 */
function groupGrants(group, allRoles) {
    /** @type {Set<string>} */
    const perms = new Set();
    let unknownRole = false;
    for (const p of Array.isArray(group.permissions) ? group.permissions : []) perms.add(String(p));
    /** @type {Record<string, readonly string[]>} */
    const implied = permissions.GROUP_GRANT_IMPLIED_PERMISSIONS || {};
    for (const cap of Array.isArray(group.granted_capabilities) ? group.granted_capabilities : []) {
        for (const p of implied[cap] || []) perms.add(p);
    }
    for (const rid of Array.isArray(group.roles) ? group.roles : []) {
        const role = (allRoles || []).find((r) => r?.id === rid);
        if (!role) { unknownRole = true; continue; }
        for (const p of Array.isArray(role.permissions) ? role.permissions : []) perms.add(String(p));
    }
    return { perms, unknownRole };
}

/**
 * May a caller who is not a super admin hand out this global group? Only when
 * it grants nothing the caller does not hold, and never the 'all' wildcard:
 * that one is assignable by a super admin only.
 * @param {Record<string, any>} group
 * @param {Record<string, any>[]} allRoles
 * @param {string[]} callerPerms
 */
function globalGroupWithinCaller(group, allRoles, callerPerms) {
    const { perms, unknownRole } = groupGrants(group, allRoles);
    if (unknownRole || perms.has('all')) return false;
    if (callerPerms.includes('all')) return true;
    for (const p of perms) if (!callerPerms.includes(p)) return false;
    return true;
}

/**
 * Which of `groupIds` may the caller not assign? A group of an organisation the
 * caller does not administer is refused. A global group (no organizationId) is
 * refused when it grants more than the caller holds, or the 'all' wildcard at
 * all; super admins return before this runs. Ids in `existing` (the target's
 * current groups) are an echo of the stored row, not an assignment, and pass.
 *
 * Unknown ids are reported as denied rather than ignored: a group that does not
 * exist cannot be one of the caller's, and silently dropping it would let a
 * probe distinguish "no such group" from "not yours".
 * @param {Request} req
 * @param {unknown[]} groupIds
 * @param {{ existing?: unknown[] }} [opts]
 * @returns {Promise<string[]>}
 */
async function groupsOutsideCallerOrg(req, groupIds, { existing = [] } = {}) {
    const wanted = groupIds.map(g => String(g ?? '').trim()).filter(Boolean);
    if (wanted.length === 0) return [];

    const me = await userStore.getUser(req.session?.user?.id);
    // Not just me.organizationId: an admin can administer an org through a
    // group rather than a primary assignment (the same asymmetry orgsAdministeredBy
    // exists for), and keying on the primary org alone would refuse them their
    // own groups.
    const myOrgIds = new Set(await orgsAdministeredBy(me));
    const allGroups = await userStore.getAllGroups();

    const kept = new Set((Array.isArray(existing) ? existing : []).map(g => String(g ?? '').trim()));
    /** @type {{ roles: Record<string, any>[], perms: string[] } | null} */
    let callerGrants = null;
    const loadCallerGrants = async () => {
        if (!callerGrants) {
            callerGrants = {
                roles: (await userStore.getAllRoles()) || [],
                perms: (await permissions.getUserPermissions(req.session?.user?.id, req.session)) || [],
            };
        }
        return callerGrants;
    };

    /** @type {string[]} */
    const denied = [];
    for (const gid of wanted) {
        const group = (allGroups || []).find(g => g?.id === gid);
        if (!group) { denied.push(gid); continue; }
        const groupOrg = normaliseOrgId(group.organizationId);
        if (groupOrg === null) {
            if (kept.has(gid)) continue;
            const { roles, perms } = await loadCallerGrants();
            if (!globalGroupWithinCaller(group, roles, perms)) denied.push(gid);
            continue;
        }
        if (!myOrgIds.has(groupOrg)) denied.push(gid);
    }
    return denied;
}

/**
 * Which of `groupIds` may not be a default group of `orgId`? A default group is
 * handed to every new member of that organisation, so it must belong to that
 * organisation or be a global group the caller may assign themselves
 * (groupsOutsideCallerOrg). Ids in `existing` (the stored list) are not
 * re-checked, so an unchanged list round-trips. Super admins are exempt.
 * @param {Request} req
 * @param {string} orgId
 * @param {unknown[]} groupIds
 * @param {{ existing?: unknown[] }} [opts]
 * @returns {Promise<string[]>}
 */
async function defaultGroupsRefused(req, orgId, groupIds, { existing = [] } = {}) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return [];
    const kept = new Set((Array.isArray(existing) ? existing : []).map(g => String(g ?? '').trim()));
    const added = [...new Set(groupIds.map(g => String(g ?? '').trim()).filter(g => g && !kept.has(g)))];
    if (added.length === 0) return [];
    const target = normaliseOrgId(orgId);
    const allGroups = (await userStore.getAllGroups()) || [];
    const denied = new Set(await groupsOutsideCallerOrg(req, added));
    for (const gid of added) {
        const group = allGroups.find(g => g?.id === gid);
        if (!group) { denied.add(gid); continue; }
        const groupOrg = normaliseOrgId(group.organizationId);
        if (groupOrg !== null && groupOrg !== target) denied.add(gid);
    }
    return added.filter(g => denied.has(g));
}

// Upper bound on an organisation's default-group list.
const MAX_DEFAULT_GROUPS = 200;

/**
 * The refusal for a new default-group list of `orgId`, or null when it may be
 * stored: a list of at most MAX_DEFAULT_GROUPS ids (each at most 200
 * characters), every newly added id passing defaultGroupsRefused.
 * @param {Request} req
 * @param {string} orgId
 * @param {unknown} defaultGroups
 * @param {unknown[]} existing  the stored list
 * @returns {Promise<{ status: number, body: Record<string, unknown> } | null>}
 */
async function defaultGroupsUpdateRefusal(req, orgId, defaultGroups, existing) {
    if (!Array.isArray(defaultGroups) || defaultGroups.length > MAX_DEFAULT_GROUPS
        || defaultGroups.some((g) => typeof g !== 'string' || g.length > 200)) {
        return { status: 400, body: { error: 'defaultGroups must be a list of group ids.' } };
    }
    const refused = await defaultGroupsRefused(req, orgId, defaultGroups, { existing });
    if (refused.length === 0) return null;
    return {
        status: 403,
        body: { error: `You can only assign groups in your organisation: ${refused.join(', ')}`, code: 'cross_org_group_denied', groups: refused },
    };
}

module.exports = {
    orgsAdministeredBy,
    normaliseOrgId,
    groupsOutsideCallerOrg,
    globalGroupWithinCaller,
    defaultGroupsRefused,
    defaultGroupsUpdateRefusal,
};
