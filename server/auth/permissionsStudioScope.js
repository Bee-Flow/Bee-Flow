// @typecheck
/**
 * Permissions — the Studio authorization helpers: assertUserCanUseOrg and
 * validateSharedGroupsForOrg (see the header of auth/permissions.js for when
 * to use each).
 *
 * Part of auth/permissions.js (the public surface); import from there.
 */

const { dep } = require('./permissionsDeps');
/** @type {typeof import('../stores/userStore')} */
const userStore = dep('userStore');
const { resolveUserOrgIds } = require('./permissionsResolve');

/**
 * Studio authorization helper: throws a 403-shaped Error if the requesting
 * user does not belong to `orgId`. If `orgId` is falsy, falls back to the
 * user's primary org. Returns the validated orgId.
 *
 * Super admins (resolveUserOrgIds === null) bypass the membership check but
 * still get back the orgId they supplied (or null if none).
 *
 * Usage:
 *   try {
 *     const orgId = await assertUserCanUseOrg(req, req.body.organizationId);
 *     // proceed with orgId
 *   } catch (err) {
 *     return res.status(err.status || 500).json({ error: err.message });
 *   }
 */
async function assertUserCanUseOrg(req, orgId) {
    const userOrgIds = await resolveUserOrgIds(req);
    // Super admin: trust the supplied orgId, or null
    if (userOrgIds === null) return orgId || null;

    if (!orgId) {
        // No explicit orgId — fall back to primary
        if (userOrgIds.size === 0) {
            const err = new Error('User does not belong to any organisation');
            err.status = 403;
            throw err;
        }
        return Array.from(userOrgIds)[0];
    }

    if (!userOrgIds.has(orgId)) {
        const err = new Error('Organisation not accessible');
        err.status = 403;
        throw err;
    }
    return orgId;
}

/**
 * Studio authorization helper: throws a 400-shaped Error if any of
 * `sharedGroupIds` does not belong to `orgId`. An empty/undefined list is a
 * no-op. Returns the validated array (deduped, falsy entries dropped).
 *
 * `{requireNonEmpty: true}` turns "no usable groups" into a 400
 * `groups_required` instead. Only pass it where the caller has said it wants
 * GROUP-scoped sharing: everywhere `shared_groups` is read (auth/audience.js),
 * an empty list on a published row means the ENTIRE ORGANISATION, so returning
 * [] there answers "share with these groups" with "share with everyone".
 *
 * Usage:
 *   try {
 *     const groups = await validateSharedGroupsForOrg(orgId, sharedGroups);
 *     await store.setPublished(id, true, groups);
 *   } catch (err) {
 *     return res.status(err.status || 500).json({ error: err.message });
 *   }
 */
async function validateSharedGroupsForOrg(orgId, sharedGroupIds, { requireNonEmpty = false } = {}) {
    const groupsRequired = () => {
        const err = new Error('Pick at least one group to share this with');
        err.status = 400;
        err.code = 'groups_required';
        return err;
    };
    if (sharedGroupIds === undefined || sharedGroupIds === null) {
        if (requireNonEmpty) throw groupsRequired();
        return undefined;
    }
    if (!Array.isArray(sharedGroupIds)) {
        const err = new Error('sharedGroups must be an array');
        err.status = 400;
        throw err;
    }
    const ids = Array.from(new Set(sharedGroupIds.filter(Boolean)));
    if (ids.length === 0) {
        if (requireNonEmpty) throw groupsRequired();
        return [];
    }
    if (!orgId) {
        const err = new Error('Cannot assign shared groups: resource has no organisation');
        err.status = 400;
        throw err;
    }

    const allGroups = await userStore.getAllGroups();
    const orgGroupIds = new Set(allGroups.filter(g => g.organizationId === orgId).map(g => g.id));
    const invalid = ids.filter(id => !orgGroupIds.has(id));
    if (invalid.length > 0) {
        const err = new Error(`Invalid groups for this organisation: ${invalid.join(', ')}`);
        err.status = 400;
        throw err;
    }
    return ids;
}

module.exports = {
    assertUserCanUseOrg,
    validateSharedGroupsForOrg,
};
