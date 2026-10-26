const { sessionUser } = require('../../core/http/sessionUser');
// @typecheck strict
/**
 * The pieces that every /api/studio aggregate shares.
 *
 * counts.js and search.js were written to the same three rules and grew the
 * same two helpers twice: a lazily memoised dependency object, and the four
 * non-middleware twins of the mount gates. attention.js is the third aggregate
 * asking the same question ("what may this caller see"), and a third copy is
 * how the three quietly start answering it differently — one file learns that
 * a licence check must be awaited before the module check, another does not.
 *
 * So the answer lives here once. Nothing about it is new: every function below
 * is the body it had in counts.js, moved.
 *
 * The gate helpers stay HELPERS rather than middleware on purpose. Middleware
 * refuses the whole request; these three routes must instead OMIT what the
 * caller may not see, because a 403 on the aggregate would tell a Community org
 * there is something behind the door.
 *
 * ── THE GATES GIVE THREE ANSWERS, NOT TWO ─────────────────────────────────
 *
 * `true` = may, `false` = may not, and a `GateUndecidable` throw = we could not
 * establish it. That third one is the reason this block exists.
 * All three of the underlying checks FAIL CLOSED WITHOUT THROWING, and a closed
 * gate on these screens means "not yours", a known, permanent absence that is
 * not called a gap. Without the distinction a failure is quietly promoted to a reassuring "you do not have that kind":
 *
 *   license/middleware.js:228   `resolution.error === 'tier_unavailable'` →
 *                               { allowed: false }. requireFeature makes a
 *                               503 of that itself, precisely because it is not a 403.
 *   entitlements.js:648-657     hasCapability gives false on a throw AND on
 *                               a `degraded` snapshot ("FAILS CLOSED … rather
 *                               than throwing, because it runs in hot paths").
 *   permissions.js:676-686      getUserPermissions gives ['page_chat'] on a
 *                               DB error and sets `_lastPermLookupFailedAt`, with
 *                               the comment instructing that a route that wants a hard answer
 *                               must consult `isPermissionLookupDegraded()`. That happens here.
 *
 * The callers each handle the throw in their own way, and all three on the side of "unknown narrows": counts.js omits the key and marks the answer
 * partial, search.js puts the kind in `errors[]`, attention.js in `unavailable[]` (never in `gated[]`).
 */

'use strict';

/**
 * "This gate could not be answered." Its own type so that a caller can recognise it;
 * every caller today treats it the same as any other throw, and that is exactly right.
 */
class GateUndecidable extends Error {
    /**
     * @param {string} what
     */
    constructor(what) {
        super(`gate undecidable: ${what}`);
        this.name = 'GateUndecidable';
        this.gate = what;
    }
}

/**
 * A dependency object whose modules are required on first touch.
 *
 * @template {Record<string, () => any>} L
 * @param {L} loaders  name → require thunk
 * @returns {{ [K in keyof L]: ReturnType<L[K]> }}
 */
function makeLazyDeps(loaders) {
    /** @type {Record<string, any>} */
    const memo = {};
    const deps = {};
    for (const [name, load] of Object.entries(loaders)) {
        Object.defineProperty(deps, name, {
            enumerable: true,
            get() { if (!(name in memo)) memo[name] = load(); return memo[name]; },
        });
    }
    return /** @type {{ [K in keyof L]: ReturnType<L[K]> }} */ (deps);
}

/**
 * The gate and scoping dependencies (see the DEFAULT_LOADERS of counts.js).
 * @typedef {{
 *   modules: typeof import('../../modules'),
 *   license: typeof import('../../license/middleware'),
 *   entitlements: typeof import('../../core/entitlements/entitlements'),
 *   permissions: typeof import('../../auth/permissions'),
 *   auth: typeof import('../../auth'),
 *   configStore: typeof import('../../stores/configStore'),
 *   projectStore: typeof import('../../stores/projectStore'),
 *   kbStore: typeof import('../../stores/knowledgeBases'),
 *   kbShared: typeof import('../knowledgeBases/shared'),
 * }} GateDeps
 */

/** @param {import('express').Request} req */
const userIdOf = (/** @type {import('express').Request} */ req) => sessionUser(req).id;
/** @param {import('express').Request} req */
const orgIdOf = (req) => req.session?.user?.organizationId || /** @type {string | undefined} */ (req.session?.user?.orgId) || null;

// ── Gate helpers — the non-middleware twins of the mount gates ─────────────

/**
 * Modules: isModuleActive gooit zelf als de statuslezing omvalt.
 * @param {Pick<GateDeps, 'modules'>} d
 * @param {string} id
 */
const moduleActive = (d, id) => d.modules.isModuleActive(id);

/**
 * Licence. `tier_unavailable` is the tier resolution that could NOT read — not
 * "this org does not have it".
 * @param {Pick<GateDeps, 'license'>} d
 * @param {import('express').Request} req
 * @param {string} feature
 */
const licenceAllows = async (d, req, feature) => {
    const { allowed, resolution } = (await d.license.featureAllowedForRequest(req, feature)) || {};
    if (resolution && resolution.error === 'tier_unavailable') {
        throw new GateUndecidable(`licence:${feature}`);
    }
    return !!allowed;
};

/**
 * Capability. `resolveCapabilitySet` is the same resolution as hasCapability
 * (its `has()` does literally the same alias expansion), but it REPORTS
 * `degraded` instead of selling it as a "no". A deps object that the batch
 * helper does not supply falls back to hasCapability — then nothing is lost except
 * the distinction that this helper exists to carry.
 * @param {Pick<GateDeps, 'entitlements'>} d
 * @param {import('express').Request} req
 * @param {string} capId
 */
const capability = async (d, req, capId) => {
    const ctx = { userId: userIdOf(req), orgId: orgIdOf(req), session: req.session, req };
    if (typeof d.entitlements.resolveCapabilitySet === 'function') {
        const set = await d.entitlements.resolveCapabilitySet(ctx);
        if (!set || set.degraded) throw new GateUndecidable(`capability:${capId}`);
        return !!set.has(capId);
    }
    return !!(await d.entitlements.hasCapability(capId, ctx));
};

/**
 * Rechten. `hasPermission` false is dubbelzinnig zolang de rechtenlezing
 * degraded is; permissions.js exporteert de vlag daar zelf voor.
 * @param {Pick<GateDeps, 'permissions'>} d
 * @param {import('express').Request} req
 * @param {string} perm
 */
const permission = async (d, req, perm) => {
    const ok = await d.permissions.hasPermission(userIdOf(req), perm, req.session);
    if (ok) return true;
    if (typeof d.permissions.isPermissionLookupDegraded === 'function'
        && d.permissions.isPermissionLookupDegraded()) {
        throw new GateUndecidable(`permission:${perm}`);
    }
    return false;
};

/**
 * Solutions: routes/projects.js's mount gate (requireModule('projects') +
 * requireCapability('projects')) plus the operator kill switch
 * (feature_projects_enabled). counts.js, search.js, attentionChecks.js and
 * aiRoute.js each carried this body word for word; one copy keeps the four
 * from answering "may this caller see Solutions" differently.
 * @param {import('express').Request} req
 * @param {Pick<GateDeps, 'modules' | 'entitlements' | 'configStore'>} d
 */
const solutionsGate = async (req, d) => {
    if (!(await moduleActive(d, 'projects'))) return false;
    if (!(await capability(d, req, 'projects'))) return false;
    const enabled = await d.configStore.getConfig('feature_projects_enabled');
    return enabled !== false;
};

// ── Scoping helpers — WELKE rijen, niet WELKE soort ────────────────────────

/**
 * The Solutions this caller may see: routes/projects.js GET /?kind=solution,
 * i.e. listUserProjects(userId, groups, { kind: 'solution' }). Solutions plus
 * the legacy projects nobody has classified yet, never a collaborative
 * project. listUserProjects (owner + shares) IS the authorisation; nothing
 * here widens it and no id comes out of the request.
 * @param {import('express').Request} req
 * @param {Pick<GateDeps, 'projectStore' | 'auth'>} d
 */
async function visibleSolutionsFor(req, d) {
    const userId = userIdOf(req);
    return d.projectStore.listUserProjects(userId, await d.auth.resolveUserGroups(userId), { kind: 'solution' });
}

/**
 * The knowledge bases that this caller may see.
 *
 * Stood verbatim in counts.js ('knowledge'), in search.js ('knowledge') and
 * in attentionChecks.js (knowledgeBasesToActOn) — three times the same seven
 * lines. The gate says "may this kind", this says "which ROWS", and the second
 * is the more expensive half to let diverge: a fourth
 * visibility condition that lands on only two of the three places leaves the attention screen naming knowledge bases that the knowledge list does not show.
 *
 * `resolveUserOrgIds` is STRICT here: an unreadable userStore would otherwise give an
 * empty Set, which cannot be told apart from "member of no
 * organisation at all" (permissions.js:832-866 says so in its own header).
 * Here it throws, and every caller already has a place for a throw.
 * @param {import('express').Request} req
 * @param {Pick<GateDeps, 'auth' | 'kbShared' | 'kbStore'>} d
 */
async function visibleKnowledgeBasesFor(req, d) {
    const userId = userIdOf(req);
    const orgIds = await d.auth.resolveUserOrgIds(req, { strict: true });
    const isOrgAdmin = await d.kbShared.resolveIsOrgAdmin(req);
    const systemSlugs = await d.kbShared.resolveEnabledSystemSlugs(req);
    const filter = d.kbShared.listFilterFromQuery({ query: {} });
    const kbs = await d.kbStore.listKBs(userId, orgIds, { ...filter, systemSlugs, isOrgAdmin });
    const userGroups = await d.kbShared.resolveUserGroups(req);
    return d.kbStore.filterByGroupAccess(kbs, userId, userGroups, { orgIds, isOrgAdmin });
}

module.exports = {
    GateUndecidable,
    makeLazyDeps,
    userIdOf,
    orgIdOf,
    moduleActive,
    licenceAllows,
    capability,
    permission,
    solutionsGate,
    visibleKnowledgeBasesFor,
    visibleSolutionsFor,
};
