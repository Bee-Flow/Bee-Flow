// @typecheck
/**
 * The identity a run's tool calls dispatch under. The owner's (ctx.userId,
 * ctx.session, ctx.orgId, ...) unless the run was started by somebody else on an
 * automation with `runPolicy.connections = 'caller'`: then ctx.callerOnly
 * (callerConnections.js) holds the starter's own identity, groups and org role,
 * and connection lending is off for the run. One place, so every
 * tool-dispatch site agrees.
 *
 * Caller mode only ever NARROWS: the tools a run may use are the owner's
 * catalog intersected with the caller's (permittedCatalog), and an admin
 * flag needs both to be admins. A caller with more rights than the owner gains
 * nothing from running the owner's automation.
 */

/** @typedef {{ userId: string|undefined, session: object|null|undefined, orgId: string|null|undefined, userGroupIds: string[], orgRole: string|null|undefined, homeOrgId: string|null|undefined, isAdmin: boolean }} ToolIdentity */

const isAdminSession = (session) => !!(session && (session.isAdmin || session.user?.role === 'admin'));

/** The automation owner's identity on this run. @returns {ToolIdentity} */
function ownerIdentity(ctx) {
    return {
        userId: ctx.userId, session: ctx.session, orgId: ctx.orgId,
        userGroupIds: ctx.userGroupIds || [], orgRole: ctx.orgRole, homeOrgId: ctx.userHomeOrgId,
        isAdmin: isAdminSession(ctx.session),
    };
}

/** @returns {ToolIdentity} */
function toolIdentity(ctx) {
    const c = ctx.callerOnly;
    if (!c) return ownerIdentity(ctx);
    return {
        userId: c.userId, session: c.session, orgId: c.orgId,
        userGroupIds: c.userGroupIds || [], orgRole: c.orgRole, homeOrgId: c.homeOrgId,
        // Both must be admins: the owner's rights cap what the caller can reach.
        isAdmin: !!c.isAdmin && isAdminSession(ctx.session),
    };
}

/** Connection-lending policy for the catalog lookup: none for a caller-only run. */
function lendPolicyFor(ctx) {
    if (ctx.callerOnly) return null;
    return (ctx.resourceOwnerUserId && ctx.resourceOwnerUserId !== ctx.userId)
        ? { ownerUserId: ctx.resourceOwnerUserId, resourceType: 'automation', resourceId: ctx.automationId || null }
        : null;
}

/** The (user, org) pair a memo/cache key is built from: whoever the step dispatches as. */
function stepKeyIdentity(ctx) {
    const who = toolIdentity(ctx);
    return { stepUserId: who.userId, stepOrgId: who.orgId };
}

const toolNameOf = (t) => t?.function?.name;

/**
 * The tool catalog this run may offer or dispatch. For the owner's runs it is
 * the owner's, as ever. For a caller-only run it is the owner's catalog
 * intersected with the caller's, so neither side can widen the other.
 *
 * @param {object} ctx
 * @param {(opts: object) => Promise<{ tools?: any[] }>} getIntegrationTools
 * @param {object} [options]  `lend`: ask with the connection-lending policy (owner runs only);
 *                            everything else goes to the lookup as is (automationStep, grants, ...)
 */
async function permittedCatalog(ctx, getIntegrationTools, options = {}) {
    const { lend = false, ...extra } = options;
    if (!ctx.callerOnly) {
        const who = ownerIdentity(ctx);
        return getIntegrationTools({
            userId: who.userId, session: who.session, isAdmin: who.isAdmin, ...extra,
            ...(lend ? { connectionPolicy: lendPolicyFor(ctx) } : {}),
        });
    }
    const owner = ownerIdentity(ctx);
    const caller = toolIdentity(ctx);
    const [ownerCat, callerCat] = await Promise.all([
        getIntegrationTools({ userId: owner.userId, session: owner.session, isAdmin: owner.isAdmin, ...extra, connectionPolicy: null }),
        getIntegrationTools({ userId: caller.userId, session: caller.session, isAdmin: caller.isAdmin, ...extra, connectionPolicy: null }),
    ]);
    const allowed = new Set((ownerCat?.tools || []).map(toolNameOf).filter(Boolean));
    return { ...callerCat, tools: (callerCat?.tools || []).filter((t) => allowed.has(toolNameOf(t))) };
}

module.exports = { toolIdentity, ownerIdentity, lendPolicyFor, permittedCatalog, stepKeyIdentity };
