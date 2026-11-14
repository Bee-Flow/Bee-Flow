// @typecheck strict
/**
 * The steps of PUT /users/:id, part of that route (userRoutes.js runs them in order, after the
 * org-admin gate and the body allow-list): the role value, the stored
 * snapshot, the fields to write, the organisation-admin guard and what
 * follows a successful write. A step that refuses returns the answer; the
 * route sends it.
 */

'use strict';

const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const userStore = require('../../stores/userStore');
const { isPlatformOperator } = require('../platformOperator');
const permissions = require('../permissions');
const { sanitizePlainTextFields } = require('../../utils/htmlSanitizer');
const { imageLimitsColumn, buildRoleDowngradeHint, USER_UPDATE_FIELDS, SUPER_ADMIN_ONLY_FIELDS, isKnownRoleId, USER_TEXT_FIELDS, accessChanges, endSessionsFor } = require('./userSupportRoutes');
const { isActiveUserStatus, wouldOrphanOrg, orgsAdministeredBy, normaliseOrgId } = require('./orgAdminGuards');

const { isOrgAdminRole, invalidatePermissionCache } = permissions;

/**
 * @typedef {Record<string, any>} UserRow  a stored user, or the fields written to one
 * @typedef {{ error: string, code?: string, hint?: unknown }} Refusal  the body of a refusal
 */

/**
 * The value of `role`, not just the field: the operator account keeps the
 * admin role, and any role must be one this installation defines (for
 * platform admins too: a role that resolves to nothing is a corrupted
 * record, not an assignment).
 * @param {string} id
 * @param {unknown} role
 * @returns {Promise<Refusal | null>}
 */
async function roleValueRefusal(id, role) {
    if (isPlatformOperator(id) && role && role !== 'admin') return { error: 'Cannot downgrade system admin' };
    if (role !== undefined && !(await isKnownRoleId(role))) {
        return { error: `Unknown role: ${String(role).slice(0, 64)}`, code: 'unknown_role' };
    }
    return null;
}

/**
 * The user's stored fields before the change, so the audit row captures the
 * transition and the guards know what is being given up. A failed read is no
 * snapshot: auditing must not block the update.
 * @param {string} id
 * @returns {Promise<UserRow | null>}
 */
async function userSnapshot(id) {
    try { return await userStore.getUser(id); } catch (_) { return null; }
}

/**
 * The fields to write, built from USER_UPDATE_FIELDS so they cannot fall out
 * of step with the allow-list.
 *
 * Tenant membership and the platform role are written for a platform admin
 * only (SUPER_ADMIN_ONLY_FIELDS). For anyone else the key is dropped rather
 * than refused here: the gate has already refused an actual CHANGE, so what
 * reaches this point is the users panel echoing the row back unchanged.
 *
 * A relocated user keeps no standing from the organisation they left: an
 * org_admin of the old one says nothing about the new one. An explicit
 * orgRole in the same request still wins; the operator may say what the user
 * should be on arrival.
 * @param {UserRow} body
 * @param {UserRow | null} prevUser
 * @param {boolean} isSuperAdmin
 * @returns {UserRow}
 */
function userUpdatesFrom(body, prevUser, isSuperAdmin) {
    /** @type {UserRow} */
    const updates = sanitizePlainTextFields(
        Object.fromEntries(USER_UPDATE_FIELDS.map(f => [f, body[f]])),
        USER_TEXT_FIELDS,
    );
    updates.imageLimits = imageLimitsColumn(body);
    if (!isSuperAdmin) return updates;

    for (const field of SUPER_ADMIN_ONLY_FIELDS) updates[field] = body[field];
    const movingOrg = updates.organizationId !== undefined
        && normaliseOrgId(updates.organizationId) !== normaliseOrgId(prevUser?.organizationId);
    if (movingOrg && body.orgRole === undefined) {
        updates.orgRole = normaliseOrgId(updates.organizationId) === null ? '' : 'member';
    }
    return updates;
}

/**
 * Which of the three writable fields take an administrator off an
 * organisation's roster: a demoted orgRole, another organisation, a status
 * that is not active. The platform `role` is not one of them: that is a
 * platform axis, with no bearing on who can administer a tenant.
 * @param {UserRow} prevUser
 * @param {UserRow} updates
 */
function rosterLosses(prevUser, updates) {
    const losesRole = updates.orgRole !== undefined && !isOrgAdminRole(updates.orgRole);
    const losesOrg = updates.organizationId !== undefined && updates.organizationId !== prevUser.organizationId;
    const losesActive = updates.status !== undefined && !isActiveUserStatus(updates.status);
    return { losesRole, leavesRoster: losesRole || losesOrg || losesActive };
}

/**
 * The organisations the change would leave without an administrator: every
 * one this user administers, not just their primary one, is checked.
 * @param {string} id
 * @param {UserRow} prevUser
 * @returns {Promise<{ guardedOrgIds: string[], orphans: boolean }>}
 */
async function guardedOrgs(id, prevUser) {
    const guardedOrgIds = await orgsAdministeredBy(prevUser);
    for (const guardedOrg of guardedOrgIds) {
        if (await wouldOrphanOrg(guardedOrg, id)) return { guardedOrgIds, orphans: true };
    }
    return { guardedOrgIds, orphans: false };
}

/**
 * Sole-org-admin protection, and the confirmation of one's own demotion.
 *
 * Self-demotion is allowed (an admin may hand the organisation over and step
 * down) but never as a side effect of a click: the client PUTs the whole row
 * back, so a mis-set role dropdown could strip the caller's own rights in one
 * request. The opt-in makes the client say it meant it, and the refusal
 * carries the `hint` the success response would have.
 *
 * `guardedOrgIds` are the organisations to check again after the write.
 * @param {{ id: string, prevUser: UserRow | null, updates: UserRow, callerId: string | undefined, confirmSelfDemotion: unknown }} change
 * @returns {Promise<{ guardedOrgIds: string[], lastOrgAdmin?: true, refusal?: Refusal }>}
 */
async function orgAdminGuard({ id, prevUser, updates, callerId, confirmSelfDemotion }) {
    if (!prevUser || !isOrgAdminRole(prevUser.orgRole)) return { guardedOrgIds: [] };
    const { losesRole, leavesRoster } = rosterLosses(prevUser, updates);
    /** @type {string[]} */
    let guardedOrgIds = [];
    if (leavesRoster) {
        const guarded = await guardedOrgs(id, prevUser);
        if (guarded.orphans) return { guardedOrgIds: guarded.guardedOrgIds, lastOrgAdmin: true };
        guardedOrgIds = guarded.guardedOrgIds;
    }
    if (losesRole && id && id === callerId && confirmSelfDemotion !== true) {
        const hint = buildRoleDowngradeHint(prevUser.orgRole, updates.orgRole);
        return {
            guardedOrgIds,
            refusal: {
                error: 'This would remove your own administrator rights over this organisation. Re-send with confirmSelfDemotion: true to proceed.',
                code: 'confirm_self_demotion',
                ...(hint ? { hint } : {}),
            },
        };
    }
    return { guardedOrgIds };
}

/**
 * What follows a stored update, in this order: a non-active status or a new
 * password ends the account's sessions (the person changing their own keeps
 * this one), the audit line and row (access-relevant changes only, never
 * password material), the permission cache, and the user-existence cache so
 * a demotion takes effect on the very next request. Returns the soft hint
 * for a weaker orgRole than the user had, or null.
 * @param {{ id: string, prevUser: UserRow | null, updates: UserRow, callerId: string | undefined, sessionID: string | undefined, passwordChanged: boolean }} change
 */
async function afterUserUpdate({ id, prevUser, updates, callerId, sessionID, passwordChanged }) {
    const becomesInactive = updates.status !== undefined && !isActiveUserStatus(updates.status);
    if (becomesInactive || passwordChanged) await endSessionsFor(id, id === callerId && !becomesInactive ? { keepSid: sessionID } : {});

    const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined);
    log.info(`[Audit] ${callerId || 'system'} updated user '${id}' — fields: ${changedFields.join(', ')}`);
    const { oldVals, newVals } = accessChanges(prevUser, updates);
    if (Object.keys(newVals).length > 0) {
        await userStore.logAccessAudit(
            'user.update',
            'user',
            id,
            callerId || null,
            oldVals,
            newVals,
            (prevUser && prevUser.organizationId) || updates.organizationId || null,
        );
    }
    await invalidatePermissionCache(id);
    try { await permissions.invalidateUserExistenceCache(id); } catch (err) { bestEffort('auth/admin/users:invalidateExistenceCache', err); }

    return updates.orgRole !== undefined ? buildRoleDowngradeHint(prevUser?.orgRole, updates.orgRole) : null;
}

module.exports = { roleValueRefusal, userSnapshot, userUpdatesFrom, orgAdminGuard, afterUserUpdate };
