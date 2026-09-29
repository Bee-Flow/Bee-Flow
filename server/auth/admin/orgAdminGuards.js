// @typecheck
/**
 * Admin Routes — shared org-admin authorization guards.
 *
 * The org-admin deciders (isOrgAdminForOrg, requireOrgAdmin,
 * requireOrgAdminForUser) plus the sole-org-admin anti-orphan machinery the
 * user-mutation routes are built on. Split out of auth/adminRoutes.js; the
 * facade re-exports isOrgAdminForOrg and requireOrgAdmin unchanged.
 *
 * No request schema lives here: this file declares no route. The guards read
 * `role`, `organizationId` and `groups` from the user routes that mount them
 * (userRoutes.js), and run BEFORE that route's schema: the authorization
 * decision is made on the raw body a caller sent and never on a trimmed copy.
 */

const userStore = require('../../stores/userStore');
const { isOrgAdminRole, invalidatePermissionCache } = require('../permissions');
const { tagGate } = require('../gateMeta');
const log = require('../../telemetry/log');

// A row with no status predates the column and is active; 'active' is the only
// other value that can sign in. Anything else cannot administer anything, so it
// must never be counted as an organisation's remaining admin.
//
// This comment used to assert that suspended accounts were refused at login.
// They were not — on any path. The claim read like a check that existed, which
// is why nobody went looking for it. The gate is real now and lives in one
// place (auth/accountStatusGate.js), used by all four login-completion paths;
// auth/accountStatusGate.paths.test.js fails if a fifth one appears without it.
function isActiveUserStatus(status) {
    return !status || status === 'active';
}

/**
 * How many OTHER people could still administer `orgId` once `excludeUserId`
 * stops being an admin of it.
 *
 * This is the anti-orphan count. Every user-management route in this file is
 * gated on org-admin, so an organisation whose last org_admin demotes, moves,
 * suspends or deletes themselves has no in-app way back — recovery needs direct
 * database access. A black-box test drove exactly that: PUT /users/<self> with
 * {"orgRole":"owner"} returned 200, and from the next request on the tenant's
 * only administrator was 403'd out of user management for good.
 *
 * "Can administer" mirrors isOrgAdminForOrg(): an org-admin orgRole plus
 * membership of the org, directly or through one of its groups. Super-admins are
 * deliberately NOT counted — they are platform operators, not a tenant's
 * administrator, and on a self-hosted install the tenant may be the only party
 * with any access at all.
 */
async function countOrgMembers(orgId, excludeUserId) {
    if (!orgId) return { admins: 0, members: 0 };
    const [users, groups] = await Promise.all([userStore.getAllUsers(), userStore.getAllGroups()]);
    const orgGroupIds = new Set((groups || []).filter(g => g?.organizationId === orgId).map(g => g.id));
    let admins = 0;
    let members = 0;
    for (const u of users || []) {
        if (!u || u.id === excludeUserId) continue;
        if (!isActiveUserStatus(u.status)) continue;
        let inOrg = u.organizationId === orgId;
        if (!inOrg) {
            let gids = [];
            try { gids = Array.isArray(u.groups) ? u.groups : JSON.parse(u.groups || '[]'); } catch (_) { gids = []; }
            inOrg = gids.some(gid => orgGroupIds.has(gid));
        }
        if (!inOrg) continue;
        members++;
        if (isOrgAdminRole(u.orgRole)) admins++;
    }
    return { admins, members };
}

async function countOtherOrgAdmins(orgId, excludeUserId) {
    return (await countOrgMembers(orgId, excludeUserId)).admins;
}

/**
 * Would this change strand somebody?
 *
 * The anti-orphan rule is "an organisation with people in it must keep an
 * administrator" — NOT "an org_admin row may never be removed". Those come
 * apart in the single most common account shape on this product: every
 * self-serve signup that founds an organisation creates exactly one user, with
 * orgRole 'org_admin' (accountProvisioning.createOrgPlacement). For that user
 * `countOtherOrgAdmins` is structurally zero forever, so a rule keyed on the
 * admin count alone makes the account permanently undeletable and
 * unsuspendable — through the only erasure path this product has. On a privacy
 * product, "erase my account" turning into a 409 is a worse bug than the one
 * being fixed, and an operator who cannot suspend an abusive tenant is worse
 * still.
 *
 * Nobody is stranded when there is nobody left to strand, so the guard only
 * fires when the organisation still has OTHER active members.
 */
async function wouldOrphanOrg(orgId, excludeUserId) {
    if (!orgId) return false;
    const { admins, members } = await countOrgMembers(orgId, excludeUserId);
    return members > 0 && admins === 0;
}

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
 */
async function orgsAdministeredBy(user) {
    if (!user || !isOrgAdminRole(user.orgRole)) return [];
    const orgIds = new Set();
    if (user.organizationId) orgIds.add(user.organizationId);
    let gids = [];
    try { gids = Array.isArray(user.groups) ? user.groups : JSON.parse(user.groups || '[]'); } catch (_) { gids = []; }
    if (gids.length) {
        try {
            const groups = await userStore.getAllGroups();
            for (const g of groups || []) {
                if (g?.organizationId && gids.includes(g.id)) orgIds.add(g.organizationId);
            }
        } catch (e) { log.warn('[adminRoutes] group lookup for org-admin guard failed:', e.message); }
    }
    return [...orgIds];
}

/**
 * Post-write safety net for the read-then-write race the pre-check cannot close.
 *
 * Two admins demoting each other in parallel both pass a pre-check that excludes
 * the OTHER one, and the organisation lands on zero administrators — the exact
 * unrecoverable state the guard exists to prevent. Serialising on a database
 * lock would close it properly, but holding a lock across a pooled write invites
 * pool-exhaustion deadlock, which is a worse failure than the one being fixed.
 *
 * So: re-check after the write and put the row back if the organisation is now
 * orphaned. The repair is racy in the same way, and that is fine, because it
 * races in the SAFE direction — the worst interleaving leaves one administrator
 * too many, never none. Only runs for changes that actually could orphan, so
 * ordinary edits pay nothing.
 */
async function repairIfOrphaned(orgIds, prevUser) {
    for (const orgId of orgIds) {
        // Ask the SAME question the pre-check asked — "is any OTHER member left
        // without an administrator" — by excluding the user being changed.
        // Excluding nobody instead looked equivalent and was not: after the
        // write the demoted user is a member with no admin role, so they
        // counted as their own stranded colleague. A live test caught it
        // immediately — the sole founder of a one-person organisation could not
        // demote themselves, because the pre-check correctly found nobody to
        // strand and this then reverted the write and returned 409 anyway.
        if (!(await wouldOrphanOrg(orgId, prevUser.id))) continue;
        try {
            await userStore.updateUser(prevUser.id, {
                orgRole: prevUser.orgRole,
                organizationId: prevUser.organizationId,
                status: prevUser.status,
            });
            await invalidatePermissionCache(prevUser.id);
        } catch (e) {
            log.error(`[adminRoutes] SECURITY: org '${orgId}' was left without an administrator and the rollback failed:`, e.message);
        }
        log.warn(`[adminRoutes] concurrent admin changes would have left org '${orgId}' without an administrator — reverted ${prevUser.id}`);
        return orgId;
    }
    return null;
}

// One refusal for every path that could strip an organisation's last admin, so
// the SPA can recognise it by `code` wherever it happens.
function refuseLastOrgAdmin(res, what) {
    return res.status(409).json({
        error: `${what} would leave this organisation without an administrator. Give another active member the Organisation Admin role first — nobody could manage users afterwards, and only direct database access could undo it.`,
        code: 'last_org_admin',
    });
}

/**
 * Check if the current user is an org admin for a given organization.
 * Super admins always pass. Org admins must have orgRole='org_admin' and belong to the target org.
 */
async function isOrgAdminForOrg(req, orgId) {
    // Super admin — always allowed
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;

    const userId = req.session?.user?.id;
    if (!userId) return false;

    const user = await userStore.getUser(userId);
    if (!user) return false;

    // Must be org_admin role (or legacy 'admin' value pre-rename)
    if (!isOrgAdminRole(user.orgRole)) return false;

    // Must belong to the target org
    if (user.organizationId === orgId) return true;

    // Check group-based membership as fallback
    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

    const allGroups = await userStore.getAllGroups();
    return groupIds.some(gid => {
        const g = allGroups.find(gr => gr.id === gid);
        return g?.organizationId === orgId;
    });
}

/**
 * Middleware factory: require org admin access for the org specified by req.params[paramName].
 * Falls back to requireAuth first, then checks org admin status.
 */
function requireOrgAdmin(paramName = 'id') {
    return async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
        if (!await isOrgAdminForOrg(req, orgId)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
        next();
    };
}

/**
 * Tenant ids are compared, not just read, so `''`, `null` and `undefined` have to
 * collapse to one value first — otherwise "no organisation" spelled two ways
 * reads as a change and a plain profile edit starts 403ing.
 */
function normaliseOrgId(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/**
 * Middleware: require org admin access for the user specified by :id param.
 * Looks up the target user's org and checks if the requestor is an org admin for it.
 * For POST (create user), uses req.body.organizationId since no user exists yet.
 * Also blocks org admins from setting role='admin' (super admin escalation).
 */
async function _requireOrgAdminForUser(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });

    // Super admins pass through
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (isSuperAdmin) return next();

    // Block org admins from setting platform role to 'admin'
    if (req.body?.role === 'admin') {
        return res.status(403).json({ error: 'Cannot assign super admin role' });
    }

    // Determine target org: from existing user (PUT/DELETE) or from body (POST)
    let targetOrgId = null;
    const targetUserId = req.params.id;
    let targetUser = null;
    if (targetUserId) {
        targetUser = await userStore.getUser(targetUserId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        targetOrgId = targetUser.organizationId;
    } else {
        // POST /users — use the org from the body
        targetOrgId = req.body?.organizationId;
    }

    if (!targetOrgId) {
        return res.status(403).json({ error: 'Cannot manage users without an organisation' });
    }

    if (!await isOrgAdminForOrg(req, targetOrgId)) {
        return res.status(403).json({ error: 'You can only manage users in your organisation' });
    }

    // ── C-01: authorize the DESTINATION, not only the source ──
    // Everything above answers "may I manage this user?", resolved from the row
    // as it stands. On an update that is the org the user is LEAVING, and it is
    // the wrong question on its own: an org_admin targeting their OWN account
    // passes it by construction, so `{"organizationId":"<victim>"}` walked them
    // into another tenant still carrying org_admin. A pentest did exactly that
    // and read the victim's user list and org configuration.
    //
    // Moving a user between tenants is a platform-operator action (super admins
    // returned above). For everyone else the field may be echoed back unchanged
    // — the users panel PUTs the whole row — but never altered.
    if (targetUser && Object.prototype.hasOwnProperty.call(req.body || {}, 'organizationId')) {
        if (normaliseOrgId(req.body.organizationId) !== normaliseOrgId(targetUser.organizationId)) {
            return res.status(403).json({
                error: 'Cannot move users between organisations',
                code: 'cross_org_move_denied',
            });
        }
    }

    // The platform `role` is the same shape of problem. The refusal above for
    // the literal 'admin' is kept — "you may not escalate" is a different answer
    // from "that is not a role" and both are worth giving — but it was the ONLY
    // check, so every other string sailed past. Changing the field at all is a
    // platform-operator action; echoing the stored value back is not a change.
    if (targetUser && Object.prototype.hasOwnProperty.call(req.body || {}, 'role')) {
        // The column defaults to 'user' (userStore's DDL), and rows predating
        // that default carry null — so absent, empty and 'user' are one value.
        // Treating them as distinct would 403 the panel's ordinary round-trip
        // on any such row.
        const asRole = (v) => String(v ?? '').trim() || 'user';
        if (asRole(req.body.role) !== asRole(targetUser.role)) {
            return res.status(403).json({
                error: 'Cannot change a platform role',
                code: 'role_change_denied',
            });
        }
    }

    // Same hole, second key. isOrgAdminForOrg treats membership of ANY group as
    // membership of that group's org (see its group fallback), so an unvalidated
    // `groups` array reaches another tenant without touching organizationId at
    // all — and group ids are slugified names, so they are guessable. The
    // reciprocal route (POST /groups/:id/members) already refuses this; the
    // forward one, which its own comment calls the same operation, did not.
    if (Array.isArray(req.body?.groups)) {
        const denied = await groupsOutsideCallerOrg(req, req.body.groups);
        if (denied.length > 0) {
            return res.status(403).json({
                error: `You can only assign groups in your organisation: ${denied.join(', ')}`,
                code: 'cross_org_group_denied',
                groups: denied,
            });
        }
    }
    next();
}

/**
 * Which of `groupIds` belong to an organisation the caller does not administer?
 * Groups with no organizationId are global (platform-wide roles) and are left to
 * the permission checks that already guard them.
 *
 * Unknown ids are reported as denied rather than ignored: a group that does not
 * exist cannot be one of the caller's, and silently dropping it would let a
 * probe distinguish "no such group" from "not yours".
 */
async function groupsOutsideCallerOrg(req, groupIds) {
    const wanted = groupIds.map(g => String(g ?? '').trim()).filter(Boolean);
    if (wanted.length === 0) return [];

    const me = await userStore.getUser(req.session?.user?.id);
    // Not just me.organizationId: an admin can administer an org through a
    // group rather than a primary assignment (the same asymmetry orgsAdministeredBy
    // exists for), and keying on the primary org alone would refuse them their
    // own groups.
    const myOrgIds = new Set(await orgsAdministeredBy(me));
    const allGroups = await userStore.getAllGroups();

    const denied = [];
    for (const gid of wanted) {
        const group = (allGroups || []).find(g => g?.id === gid);
        if (!group) { denied.push(gid); continue; }
        const groupOrg = normaliseOrgId(group.organizationId);
        if (groupOrg === null) continue;          // global group
        if (!myOrgIds.has(groupOrg)) denied.push(gid);
    }
    return denied;
}

// Tagged so the route walk (auth/routeWalk.cli.js) can see what this enforces.
// This is a LOCAL org-admin gate, deliberately distinct from permissions.js's
// requireOrgAdmin — permissions.js:745-751 warns the two semantics must not be
// merged (this one resolves the org from the TARGET USER, not from a path param).
// The tag records that distinction rather than papering over it.
const requireOrgAdminForUser = tagGate(_requireOrgAdminForUser, {
    axis: 'scope',
    kind: 'orgAdminOfTargetUser',
    paramDependent: true,
    note: 'Resolves the target user\'s org from req.params.id (or req.body.organizationId on create), then requires org-admin over it. Also blocks org admins from assigning role=admin. BOTH ENDS are checked: for a non-super-admin the body may not change organizationId (403 cross_org_move_denied) and may not assign a group belonging to another org (403 cross_org_group_denied) — the source-only check let an org_admin walk their own account into another tenant.',
});

module.exports = {
    isActiveUserStatus,
    countOrgMembers,
    countOtherOrgAdmins,
    wouldOrphanOrg,
    orgsAdministeredBy,
    repairIfOrphaned,
    refuseLastOrgAdmin,
    isOrgAdminForOrg,
    requireOrgAdmin,
    normaliseOrgId,
    requireOrgAdminForUser,
};
