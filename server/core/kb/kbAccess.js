// @typecheck
/**
 * Request-level knowledge-base access checks.
 *
 * The rules are auth/kbAccess.mts (read and manage, a ladder, and the tagged
 * gate `requireKbGrade`); this module wires them to the real stores and auth
 * once (`defaultKbAccess`) and hands them to every router that lets a client
 * NAME a kb id: the knowledge-base routers, notebooks, favourites, projects.
 * The KB retrieval layer (core/localKBIngest) deliberately performs no tenant
 * filtering of its own: its access boundary IS the kb id list, on the
 * documented assumption that every caller authorized those ids upstream.
 *
 * Mirrors the shape of core/support/access.js (the same pattern for inboxes).
 */

const kbStore = require('../../stores/knowledgeBases');
const permissions = require('../../auth/permissions');
const { resolveUserOrgIds } = permissions;
const { resolveUserGroups: resolveUserGroupsById } = require('../../auth/audience');
const { makeKbAccess, kbAccessOf } = require('../../auth/kbAccess.mts');
const log = require('../../telemetry/log');

/** @typedef {import('../../auth/kbAccess.mts').KbRequest} KbRequest */
/** @typedef {import('../../auth/kbAccess.mts').KbRow} KbRow */

const getUserId = (/** @type {KbRequest} */ req) => req.session?.user?.id || null;

/** Resolve the caller's group ids via the audience home (single source of truth). */
const resolveUserGroups = (/** @type {KbRequest} */ req) => resolveUserGroupsById(getUserId(req) || '');

/**
 * The organisations the caller administers (auth/permissions
 * resolveAdminOrgIds: home organisation with an admin orgRole, or a group IN
 * the organisation that carries admin rights). The KB admin shortcut (drafts,
 * group-restricted bases) applies in these organisations only. An unreadable
 * answer is no organisation.
 * @param {KbRequest} req
 * @returns {Promise<Set<string>>}
 */
async function resolveAdminOrgIds(req) {
    if (!getUserId(req)) return new Set();
    try {
        const set = await permissions.resolveAdminOrgIds(/** @type {import('express').Request} */ (req));
        return set instanceof Set ? set : new Set();
    } catch (_) { return new Set(); }
}

/** @type {import('../../auth/kbAccess.mts').KbAccessInstance | null} */
let defaultInstance = null;

/** The rules and the gate over the real stores and auth, built once. */
function defaultKbAccess() {
    if (!defaultInstance) {
        defaultInstance = makeKbAccess({
            getKB: (id) => kbStore.getKB(id),
            getUserId,
            // The rules type the request structurally; the real helpers want express's Request.
            resolveUserOrgIds: (req) => resolveUserOrgIds(/** @type {import('express').Request} */ (req)),
            resolveUserGroups: (userId) => resolveUserGroupsById(userId),
            resolveAdminOrgIds,
            resolvePermissionsByOrg: (userId, session) => permissions.resolvePermissionsByOrg(userId, session),
            canUserAccessKB: (kb, userId, orgIds, userGroups, opts) => kbStore.canUserAccessKB(kb, userId, orgIds, userGroups, opts),
            canUserManageKB: (kb, userId, orgIds, holds) => kbStore.canUserManageKB(kb, userId, orgIds, holds),
            fallback: (where, err, value) => require('../../utils/bestEffort').fallback(where, err, value),
        });
    }
    return defaultInstance;
}

/**
 * May the caller READ this base's content: the owner, the super admin, an
 * admin of the base's organisation, or a member of it once the base is
 * published (in a shared group when it names any). A management right alone
 * is not a reason: that is the gate's ladder, not this question.
 * @param {KbRequest} req
 * @param {KbRow | null | undefined} kb
 */
const canAccessKB = (req, kb) => defaultKbAccess().canReadKb(req, kb);

/**
 * May the caller MANAGE this base: the owner, the super admin, or
 * manage_knowledge held IN the base's organisation. Grants no content read
 * by itself; a project's files base is managed from its project.
 * @param {KbRequest} req
 * @param {KbRow | null | undefined} kb
 */
const canManageKB = (req, kb) => defaultKbAccess().canManageKb(req, kb);

/**
 * The route gate: loads the base behind `:id` (or `param`), refuses below
 * `minGrade`, leaves `req.kbAccess` for the handler (`kbAccessOf`).
 * @param {import('../../auth/kbAccess.mts').KbGrade} minGrade
 * @param {import('../../auth/kbAccess.mts').KbGateOptions} [options]
 */
const requireKbGrade = (minGrade, options) => defaultKbAccess().requireKbGrade(minGrade, options);

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
 * @param {KbRequest} req
 * @param {unknown} ids
 * @returns {Promise<{allowed: string[], denied: string[]}>}
 */
async function partitionAccessibleKBIds(req, ids) {
    const list = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [];
    /** @type {string[]} */
    const allowed = [];
    /** @type {string[]} */
    const denied = [];
    for (const id of list) {
        /** @type {KbRow | null} */
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
 *   - `canAccessKB` lets an ORG ADMIN reach every base in the org they
 *     administer. Right for a management screen; wrong here. An admin asking a
 *     question is asking as themselves, and an answer built from a base they
 *     only have administrative reach into is a leak with an audit trail that
 *     says "the AI said it". `core/kb/kbVisibility` passes no admin
 *     organisations.
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
 * @param {import('express').Request} req
 * @param {string[]} ids
 * @param {{surface?: string}} [opts]
 * @returns {Promise<string[]>} the ids that survive, in the order given
 */
async function usableKbIdsForRequest(req, ids, { surface = 'direct_chat' } = {}) {
    const userId = getUserId(req);
    /** @type {Set<string> | null} */
    let orgIds = null;
    /** @type {string[]} */
    let userGroups = [];
    try {
        orgIds = await resolveUserOrgIds(req);
        userGroups = await resolveUserGroups(req);
    } catch (err) {
        log.error('[kbAccess] could not resolve the caller — treating as NO knowledge bases:', /** @type {Error} */ (err).message);
        return [];
    }
    const { resolveUsableKbIds } = require('./kbSelection');
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

module.exports = {
    canAccessKB, canManageKB, requireKbGrade, kbAccessOf, defaultKbAccess,
    partitionAccessibleKBIds, usableKbIdsForRequest, resolveAdminOrgIds, resolveUserGroups,
};
