// @typecheck
/**
 * The agent access rules (auth/agentAccess.mts), wired to the real stores and
 * auth for code that has no router of its own: the automation bindings
 * (automation/agentBinding.js) hand an agent a grant and ask the edit rule
 * first. routes/agents/crud.js builds the router's instance from its own,
 * mockable imports; the rules themselves live in the one module both use.
 *
 * `makeAgentAccess(deps)` here is the edit rule on the four deps it alone needs
 * (`buildCanModifyContext`, `canModifyAgent`), the shape the bindings and
 * agents/agentAccess.test.js build; `defaultAgentAccess()` is the whole set.
 */

'use strict';

const { makeAgentEditRules, makeAgentAccess: makeFullAgentAccess } = require('../auth/agentAccess.mts');

/**
 * The edit rule on its own deps.
 * @param {import('../auth/agentAccess.mts').AgentEditDeps} deps
 */
function makeAgentAccess(deps) {
    const { buildCanModifyContext, canModifyAgent } = makeAgentEditRules(deps);
    return { buildCanModifyContext, canModifyAgent };
}

/** @type {ReturnType<typeof makeFullAgentAccess> | null} */
let defaultInstance = null;

/** The instance for code below routes/: the real auth, stores and helpers, required lazily. */
function defaultAgentAccess() {
    if (!defaultInstance) {
        defaultInstance = makeFullAgentAccess({
            getAgent: (id) => require('../stores/agentStore').getAgent(id),
            getAgentViews: (id) => require('../stores/agentStore').getAgentViews(id),
            // The rules type the request structurally; the real helpers want express's Request.
            getEffectiveUserId: (req) => require('../utils/routeHelpers').getEffectiveUserId(/** @type {import('express').Request} */ (req)),
            resolvePermissionsByOrg: (userId, session) => require('../auth/permissions').resolvePermissionsByOrg(userId, session),
            resolveUserOrgIds: (req) => require('../auth/permissions').resolveUserOrgIds(/** @type {import('express').Request} */ (req)),
            resolveUserGroups: (userId) => require('../auth/audience').resolveUserGroups(userId),
            canSeePublished: (entity, who) => require('../auth/audience').canSeePublished(/** @type {Parameters<typeof import('../auth/audience').canSeePublished>[0]} */ (entity), who),
            getUser: (id) => require('../stores/userStore').getUser(id),
            isOrgAdminRole: (role) => require('../auth/permissions').isOrgAdminRole(role),
            roles: () => {
                const { SystemRoles, OrgRoles } = require('../auth/permissions');
                return { SystemRoles, OrgRoles };
            },
            fallback: (where, err, value) => require('../utils/bestEffort').fallback(where, err, value),
            warn: (message) => require('../telemetry/log').warn(message),
        });
    }
    return defaultInstance;
}

module.exports = { makeAgentAccess, defaultAgentAccess };
