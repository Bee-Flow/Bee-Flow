/**
 * Request-level knowledge-base access checks.
 *
 * `KnowledgeBasesStore.canUserAccessKB` is the pure policy function; this module
 * is the request-shaped wrapper around it — it resolves the caller's org ids,
 * group ids and org-admin status from `req` and then applies that policy.
 *
 * It lives here (rather than inside routes/knowledgeBases.js) because more than
 * one router needs it: any route that lets a client NAME a kb id must authorize
 * that id before it is persisted or searched. The KB retrieval layer
 * (core/localKBIngest) deliberately performs no tenant filtering of its own —
 * its access boundary IS the kb id list, on the documented assumption that every
 * caller authorized those ids upstream. Notebooks did not, which is what this
 * module exists to fix.
 *
 * Mirrors the shape of support/access.js (the same pattern for inboxes).
 */

const kbStore = require('../stores/knowledgeBases');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds, isOrgAdminRole, resolveUserGroups: resolveUserGroupsById } = require('../auth');
const log = require('../telemetry/log');

const getUserId = (req) => req.session?.user?.id || null;

/** Resolve the caller's group ids via the audience home (single source of truth). */
const resolveUserGroups = (req) => resolveUserGroupsById(getUserId(req));

/** True when the caller is an organisation admin (org_admin / legacy admin). */
async function resolveIsOrgAdmin(req) {
    const userId = getUserId(req);
    if (!userId) return false;
    try {
        const user = await userStore.getUser(userId);
        return !!(user && isOrgAdminRole(user.orgRole));
    } catch (_) { return false; }
}

/**
 * Centralized KB access check.
 * - Owner (tenant_id) always has access
 * - Super admin (resolveUserOrgIds returns null) always has access
 * - Org admin: every KB in their organisation (incl. drafts + group-restricted)
 * - Org member: KB must be in their org AND published AND, if shared_groups
 *   is set, the user must belong to at least one of those groups
 */
async function canAccessKB(req, kb) {
    const userId = getUserId(req);
    if (!kb) return false;
    if (kb.tenant_id === userId) return true;
    const orgIds = await resolveUserOrgIds(req);
    const userGroups = await resolveUserGroups(req);
    const isOrgAdmin = await resolveIsOrgAdmin(req);
    return kbStore.canUserAccessKB(kb, userId, orgIds, userGroups, { isOrgAdmin });
}

/**
 * Authorize a client-supplied list of kb ids.
 *
 * Resolves each id and applies canAccessKB. Returns the ids the caller may use
 * plus the ones they may not, so a route can choose between rejecting the
 * request (mutations — the caller is naming something that isn't theirs) and
 * silently dropping them (reads over already-persisted rows, which may predate
 * the check).
 *
 * Unknown/deleted ids count as denied: they can't be authorized, and letting
 * them through would re-create the same trust-the-client hole.
 *
 * @returns {Promise<{allowed: string[], denied: string[]}>}
 */
async function partitionAccessibleKBIds(req, ids) {
    const list = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [];
    const allowed = [];
    const denied = [];
    for (const id of list) {
        let kb = null;
        try { kb = await kbStore.getKB(id); } catch (_) { kb = null; }
        if (kb && await canAccessKB(req, kb)) allowed.push(id);
        else denied.push(id);
    }
    return { allowed, denied };
}

/**
 * The RETRIEVAL question, request-shaped: which of these ids may the caller
 * actually have searched on `surface`.
 *
 * This is deliberately NOT `partitionAccessibleKBIds`, and it is never wider
 * than it:
 *
 *   - `canAccessKB` lets an ORG ADMIN reach every base in their org. Right for
 *     a management screen; wrong here. An admin asking a question is asking as
 *     themselves, and an answer built from a base they only have
 *     administrative reach into is a leak with an audit trail that says "the
 *     AI said it". `core/kb/kbVisibility` pins isOrgAdmin to false.
 *   - it also asks the SURFACE question (`usage_contexts`), which the linker
 *     does not: a base its owner limited to one automation must not answer in a
 *     chat window.
 *
 * Use this wherever a stored or client-supplied list is about to become
 * something a person READS — including the moment it is saved, so that "saved"
 * means "will actually be used" instead of "accepted and then silently
 * ignored".
 *
 * Fails CLOSED: a caller whose orgs/groups cannot be resolved gets an empty
 * list, never an unfiltered one.
 *
 * @param {object} req
 * @param {string[]} ids
 * @param {{surface?: string}} [opts]
 * @returns {Promise<string[]>} the ids that survive, in the order given
 */
async function usableKbIdsForRequest(req, ids, { surface = 'direct_chat' } = {}) {
    const userId = getUserId(req);
    let orgIds = null;
    let userGroups = [];
    try {
        orgIds = await resolveUserOrgIds(req);
        userGroups = await resolveUserGroups(req);
    } catch (err) {
        log.error('[kbAccess] could not resolve the caller — treating as NO knowledge bases:', err.message);
        return [];
    }
    const { resolveUsableKbIds } = require('../core/kb/kbSelection');
    return resolveUsableKbIds(ids, {
        userId,
        // resolveUserOrgIds yields null for a super admin, and null means
        // "super admin, allow everything" to canUserAccessKB. Coerced to a Set
        // here so this answers the same as the turn does — promptAssembly
        // coerces identically, and the two MUST agree or the picker shows a
        // base the answer never used.
        orgIds: orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []),
        userGroups,
        surface,
    });
}

module.exports = { canAccessKB, partitionAccessibleKBIds, usableKbIdsForRequest, resolveIsOrgAdmin, resolveUserGroups };
