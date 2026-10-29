// @typecheck
/**
 * Audience helper — single source of truth for "can this user see / use a
 * published entity (agent, KB, app, …)?".
 *
 * The same `is_published` + `shared_groups` rule is applied to several
 * entities. Putting the predicate here means a single fix at this layer
 * propagates to every caller, and prevents the silent drift that hid the
 * KB-publish-wipes-shared_groups bug for several releases.
 */

const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('./permissions');
const { fallback } = require('../utils/bestEffort');

/**
 * @param {unknown} value  an array, a JSON string, or anything else (no groups)
 */
function _parseSharedGroups(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value || '[]'); } catch (_) { return []; }
    }
    return [];
}

/**
 * Decide whether a user is allowed to read/use a published entity.
 *
 * `entity` is a row with the publish/audience columns: either `owner_id` or
 * `tenant_id` is treated as "owner"; `organization_id`, `is_published`, and
 * `shared_groups` (array or JSON string) are read. `ctx.orgIds` comes from
 * resolveUserOrgIds(req) (null = super admin), `ctx.userGroups` holds the
 * group IDs from a fresh DB read.
 *
 * @param {{ owner_id?: string | null, tenant_id?: string | null, organization_id?: string | null,
 *   is_published?: boolean | null, shared_groups?: unknown } | null | undefined} entity
 * @param {{ userId: string | null, orgIds: Set<string> | null, userGroups: string[] }} ctx
 * @returns {boolean}
 */
function canSeePublished(entity, { userId, orgIds, userGroups }) {
    if (!entity) return false;

    // Owner always passes (handles agents `owner_id` and KBs `tenant_id`)
    if (userId && (entity.owner_id === userId || entity.tenant_id === userId)) return true;

    // Super admin bypass
    if (orgIds === null) return true;

    // Drafts hidden from non-owners
    if (!entity.is_published) return false;

    // Org isolation — entity must belong to one of the user's orgs
    if (!entity.organization_id) return false;
    if (!(orgIds instanceof Set) || !orgIds.has(entity.organization_id)) return false;

    // Group restriction — empty array means "entire org"
    const groups = _parseSharedGroups(entity.shared_groups);
    if (groups.length === 0) return true;
    return groups.some(g => userGroups.includes(g));
}

/**
 * Fresh-from-DB resolution of a user's group IDs. Routes that gate by
 * audience must use this rather than `req.session.user.groups`, which is
 * stale until the user re-logs in.
 * @param {string} userId
 */
async function resolveUserGroups(userId) {
    if (!userId) return [];
    try {
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        if (typeof user.groups === 'string') {
            try { return JSON.parse(user.groups || '[]'); } catch (e) { return fallback('audience:groups-json', e, []); }
        }
    } catch (err) { fallback('audience:resolve-groups', err); }
    return [];
}

/**
 * Convenience: build the full {userId, orgIds, userGroups} context from a request.
 */
async function resolveAudienceContext(req) {
    const userId = req.session?.user?.id || null;
    const orgIds = await resolveUserOrgIds(req);
    const userGroups = userId ? await resolveUserGroups(userId) : [];
    return { userId, orgIds, userGroups };
}

module.exports = {
    canSeePublished,
    resolveUserGroups,
    resolveAudienceContext,
};
