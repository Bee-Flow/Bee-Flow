// @typecheck strict
/**
 * Admin Routes — shared org-admin authorization guards.
 *
 * The org-admin deciders (isOrgAdminForOrg, requireOrgAdmin,
 * requireOrgAdminForUser) plus the sole-org-admin anti-orphan machinery the
 * user-mutation routes are built on. Split out of auth/adminRoutes.js; the
 * facade re-exports isOrgAdminForOrg and requireOrgAdmin unchanged.
 *
 * Who administers an organisation is decided in one place:
 * permissions._evalOrgAdmin (auth/permissionsOrgGates.js). A person administers
 * org X when X is their own organisation and their orgRole is an admin role, or
 * when they belong to a group OF X that carries an admin permission or role.
 * Belonging to some group of X is membership, not administration. Every gate in
 * this file asks that question.
 *
 * The anti-orphan count (countOrgMembers) counts a narrower set: the people
 * whose every way out of administering X is itself guarded. That is the
 * org-admin orgRole in X as their own organisation. Demoting, moving,
 * suspending or deleting such a person, and their leave-org, all run the
 * guard. An admin-carrying group grants administration too, but leaving that
 * group or editing it runs no guard, so a group member is never counted as
 * the cover that lets the last guarded admin go.
 * (Decision record: docs/docs/contributing/decisions/, "An organisation admin
 * is not a platform admin".)
 *
 * No request schema lives here: this file declares no route. The guards read
 * `role`, `organizationId` and `groups` from the user routes that mount them
 * (userRoutes.js), and run BEFORE that route's schema: the authorization
 * decision is made on the raw body a caller sent and never on a trimmed copy.
 */

const userStore = require('../../stores/userStore');
const { _evalOrgAdmin, isOrgAdminRole, invalidatePermissionCache } = require('../permissions');
const { tagGate } = require('../gateMeta');
const { isPlatformOperator } = require('../platformOperator');
const log = require('../../telemetry/log');
const {
    orgsAdministeredBy, normaliseOrgId, groupsOutsideCallerOrg, globalGroupWithinCaller, defaultGroupsRefused,
} = require('./groupAssignGuards');

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 * @typedef {import('express').NextFunction} NextFunction
 */

// A row with no status predates the column and is active; 'active' is the only
// other value that can sign in. Anything else cannot administer anything, so it
// must never be counted as an organisation's remaining admin.
//
// Suspended accounts are refused at login by one gate (auth/accountStatusGate.js),
// used by all four login-completion paths;
// auth/accountStatusGate.paths.test.js fails if a fifth one appears without it.
/** @param {unknown} status */
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
 * "Could still administer" counts only the guarded shape (see the header): the
 * org is their own and their orgRole is an admin role, which is the direct half
 * of _evalOrgAdmin. Someone who administers the org only through an
 * admin-carrying group is not counted: they can leave or lose that group
 * without any guard running, so they cannot be what makes a demotion safe. A
 * member is anyone in the org, directly or through one of its groups. Super-admins are
 * deliberately NOT counted — they are platform operators, not a tenant's
 * administrator, and on a self-hosted install the tenant may be the only party
 * with any access at all.
 * @param {string | null | undefined} orgId
 * @param {string} excludeUserId
 */
async function countOrgMembers(orgId, excludeUserId) {
    if (!orgId) return { admins: 0, members: 0 };
    const [users, allGroups] = await Promise.all([userStore.getAllUsers(), userStore.getAllGroups()]);
    const groups = allGroups || [];
    const orgGroupIds = new Set(groups.filter(g => g?.organizationId === orgId).map(g => g.id));
    let admins = 0;
    let members = 0;
    for (const u of users || []) {
        if (!u || u.id === excludeUserId) continue;
        if (!isActiveUserStatus(u.status)) continue;
        let inOrg = u.organizationId === orgId;
        if (!inOrg) {
            /** @type {string[]} */
            let gids = [];
            try { gids = Array.isArray(u.groups) ? u.groups : JSON.parse(u.groups || '[]'); } catch (_) { gids = []; }
            inOrg = gids.some(gid => orgGroupIds.has(gid));
        }
        if (!inOrg) continue;
        members++;
        if (u.organizationId === orgId && isOrgAdminRole(u.orgRole)) admins++;
    }
    return { admins, members };
}

/**
 * @param {string | null | undefined} orgId
 * @param {string} excludeUserId
 */
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
 * @param {string | null | undefined} orgId
 * @param {string} excludeUserId
 */
async function wouldOrphanOrg(orgId, excludeUserId) {
    if (!orgId) return false;
    const { admins, members } = await countOrgMembers(orgId, excludeUserId);
    return members > 0 && admins === 0;
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
 * @param {string[]} orgIds
 * @param {Record<string, any>} prevUser
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
            log.error(`[adminRoutes] SECURITY: org '${orgId}' was left without an administrator and the rollback failed:`, /** @type {Error} */ (e).message);
        }
        log.warn(`[adminRoutes] concurrent admin changes would have left org '${orgId}' without an administrator — reverted ${prevUser.id}`);
        return orgId;
    }
    return null;
}

// One refusal for every path that could strip an organisation's last admin, so
// the SPA can recognise it by `code` wherever it happens.
/**
 * @param {Response} res
 * @param {string} what
 */
function refuseLastOrgAdmin(res, what) {
    return res.status(409).json({
        error: `${what} would leave this organisation without an administrator. Give another active member the Organisation Admin role first — nobody could manage users afterwards, and only direct database access could undo it.`,
        code: 'last_org_admin',
    });
}

/**
 * Is the current user an admin of `orgId`? Super admins always pass. Anyone
 * else passes only on _evalOrgAdmin (see the header): their own organisation
 * with an admin orgRole, or a group of `orgId` that carries admin rights.
 * Membership of an ordinary group of `orgId` is not enough.
 * @param {Request} req
 * @param {string | string[]} orgId
 */
async function isOrgAdminForOrg(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    // A repeated path or query parameter arrives as an array: it names no single org.
    if (typeof orgId !== 'string' || !orgId) return false;

    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user) return false;
    return _evalOrgAdmin(user, (await userStore.getAllGroups()) || [], orgId);
}

/**
 * A password reset or a two-factor reset by someone else hands over the
 * account. An organisation admin may do that for a member of their
 * organisation, but not for an account that administers an organisation the
 * caller does not (an admin-carrying group of another organisation): that
 * account is that organisation's to manage. A platform admin may. Returns the
 * refusal body, or null.
 * @param {Request} req
 * @param {Record<string, any> | null | undefined} target
 * @returns {Promise<{ error: string, code: string } | null>}
 */
async function credentialResetRefusal(req, target) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return null;
    if (!target || target.id === req.session?.user?.id) return null;
    for (const orgId of await orgsAdministeredBy(target)) {
        if (!(await isOrgAdminForOrg(req, orgId))) {
            return {
                error: 'This account administers another organisation; only a platform administrator can reset its password or two-factor authentication',
                code: 'admin_elsewhere_target',
            };
        }
    }
    return null;
}

/**
 * Middleware factory: require org admin access for the org specified by req.params[paramName].
 * Falls back to requireAuth first, then checks org admin status.
 * @param {string} [paramName]
 */
function requireOrgAdmin(paramName = 'id') {
    // Tagged like permissions.js's requireOrgAdmin so the route walk sees it.
    return tagGate(async (/** @type {Request} */ req, /** @type {Response} */ res, /** @type {NextFunction} */ next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
        if (!await isOrgAdminForOrg(req, orgId)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
        next();
    }, { axis: 'scope', kind: 'orgAdminOfParam', param: paramName, paramDependent: true });
}

/**
 * Middleware: require org admin access for the user specified by :id param.
 * Looks up the target user's org and checks if the requestor is an org admin for it.
 * For POST (create user), uses req.body.organizationId since no user exists yet.
 * Also blocks org admins from setting role='admin' (super admin escalation),
 * and from acting on an account that is a platform admin (403 platform_admin_target).
 * @param {import('express').Request<{ id?: string }>} req
 * @param {Response} res
 * @param {NextFunction} next
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
        // A platform admin's account (password, two-factor, status, deletion,
        // avatar) is managed by a platform admin only, also when that account
        // is a member of the caller's organisation: whoever controls it holds
        // every instance-wide setting and every organisation.
        if (targetUser.role === 'admin' || isPlatformOperator(targetUser)) {
            return res.status(403).json({
                error: 'Only a platform administrator can manage a platform administrator',
                code: 'platform_admin_target',
            });
        }
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
        /** @param {unknown} v */
        const asRole = (v) => String(v ?? '').trim() || 'user';
        if (asRole(req.body.role) !== asRole(targetUser.role)) {
            return res.status(403).json({
                error: 'Cannot change a platform role',
                code: 'role_change_denied',
            });
        }
    }

    // The destination again, second key. A group of another organisation makes
    // its members part of that organisation, and a group there that carries
    // admin rights makes them its administrator, so `groups` may only name
    // groups of an organisation the caller administers (or a global group
    // within the caller's own grants). Group ids are slugified names, so they
    // are guessable. The reciprocal route (POST /groups/:id/members) applies
    // the same check.
    if (Array.isArray(req.body?.groups)) {
        const denied = await groupsOutsideCallerOrg(req, req.body.groups, {
            existing: Array.isArray(targetUser?.groups) ? targetUser.groups : [],
        });
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

// Tagged so the route walk (auth/routeWalk.cli.js) can see what this enforces.
// It decides org-admin exactly as permissions.js's requireOrgAdmin does
// (_evalOrgAdmin); it differs in WHICH org it asks about: the org of the
// TARGET USER (or the body's organizationId on create), not a path param.
const requireOrgAdminForUser = tagGate(_requireOrgAdminForUser, {
    axis: 'scope',
    kind: 'orgAdminOfTargetUser',
    paramDependent: true,
    note: 'Resolves the target user\'s org from req.params.id (or req.body.organizationId on create), then requires org-admin over it. Also blocks org admins from assigning role=admin, and from acting on a target that is a platform admin (403 platform_admin_target). BOTH ENDS are checked: for a non-super-admin the body may not change organizationId (403 cross_org_move_denied) and may not assign a group belonging to another org, nor a global group granting more than the caller holds or the all wildcard (403 cross_org_group_denied) — the source-only check let an org_admin walk their own account into another tenant.',
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
    credentialResetRefusal,
    requireOrgAdmin,
    normaliseOrgId,
    requireOrgAdminForUser,
    groupsOutsideCallerOrg,
    globalGroupWithinCaller,
    defaultGroupsRefused,
};
