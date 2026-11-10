// @typecheck
/**
 * Who may EDIT an agent: the one write gate in front of every mutating agent
 * endpoint (PUT/DELETE, tool params, publish, knowledge routes), and now also
 * in front of the code that hands an agent a grant of its own (the automation
 * bindings, automation/agentBinding.js).
 *
 * Moved out of routes/agents/crud.js so code below routes/ can ask the same
 * question without requiring a router (server/layering.test.js forbids that).
 * routes/agents/crud.js builds its instance from its own, mockable imports and
 * re-exports canModifyAgent and buildCanModifyContext, so nothing that reaches
 * them through the router changes; routes/agents/crud.authz.test.js is the
 * contract of the rules.
 *
 * Everything the rules read comes in through `deps` (functions, resolved at
 * call time), and `defaultAgentAccess()` wires the real ones lazily.
 */

'use strict';

const { fallback } = require('../utils/bestEffort');

/**
 * @typedef {{ holds: (permission: string, orgId: string | null | undefined) => boolean }} OrgPermissions
 *   auth/permissions resolvePermissionsByOrg: does the user hold a permission IN that organisation
 */

/** @type {OrgPermissions} */
const HOLDS_NOWHERE = Object.freeze({ holds: () => false });

/**
 * @param {{
 *   resolvePermissionsByOrg: (userId: string, session?: any) => Promise<OrgPermissions>,
 *   resolveUserOrgIds: (req: any) => Promise<Set<string>|null>,
 *   getUser: (userId: string) => Promise<any>,
 *   roles: () => { SystemRoles: { SUPER_ADMIN: string }, OrgRoles: { AGENT_EDITOR: string } },
 * }} deps
 */
function makeAgentAccess(deps) {
    // Prefetch the per-request inputs canModifyAgent needs so list endpoints can
    // compute `can_edit` for many agents without N× user/permission lookups.
    /**
     * @param {string} userId
     * @returns {Promise<{ permissions: OrgPermissions, orgIds: Set<string> | null, user: any }>}
     */
    async function buildCanModifyContext(userId, /** @type {import('express').Request} */ req) {
        if (!userId) return { permissions: HOLDS_NOWHERE, orgIds: new Set(), user: null };
        const [permissions, orgIds, user] = await Promise.all([
            // A failed permission read grants nothing.
            Promise.resolve().then(() => deps.resolvePermissionsByOrg(userId, req.session))
                .catch((e) => fallback('agents/agentAccess:buildCanModifyContext#permissions', e, HOLDS_NOWHERE)),
            Promise.resolve(deps.resolveUserOrgIds(req)).catch(() => new Set()),
            Promise.resolve(deps.getUser(userId)).catch((e) => fallback('agents/agentAccess:buildCanModifyContext', e, null)),
        ]);
        return { permissions: permissions || HOLDS_NOWHERE, orgIds, user };
    }

    // The single authoritative per-agent write gate. Rules in order:
    //   1. Owners may always modify their own agent (checked FIRST — owners
    //      without manage_agents must keep their publish/knowledge flows).
    //   2. Super-admins may modify anything.
    //   3. Everyone else needs membership in the agent's organisation AND the
    //      manage_agents permission IN THAT organisation: a right held in
    //      another organisation (BFSF-271), or in an organisation the user
    //      shares with this one through another group, does not count.
    //   4. Org-less agents (system/swarm/personal drafts) are owner/super-admin only.
    //   5. Agent Editors cannot modify unpublished drafts from others.
    // Using an agent shared with the user is a separate question (canReadAgent).
    // `ctx` (optional) is a buildCanModifyContext() result for list endpoints.
    /**
     * @param {string} userId
     * @param {{ permissions: OrgPermissions, orgIds: Set<string> | null, user: any } | null} [ctx]
     */
    async function canModifyAgent(agent, userId, /** @type {import('express').Request} */ req, ctx = null) {
        if (agent.owner_id === userId) return true;

        const { SystemRoles, OrgRoles } = deps.roles();

        // Super admin bypass
        if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return true;

        // Org-less agents have no org to scope by → owner/super-admin only.
        if (!agent.organization_id) return false;

        const c = ctx || await buildCanModifyContext(userId, req);

        // Org scoping: the requester must belong to the agent's organization.
        // resolveUserOrgIds returns null only for super-admins (handled above);
        // keep the null-guard so a degenerate ctx can never widen access.
        if (c.orgIds === null || !c.orgIds.has(agent.organization_id)) return false;

        // Non-owners always need manage_agents, held in the agent's own
        // organisation. Centralised here so every caller inherits it instead
        // of enforcing it ad hoc.
        if (!c.permissions || !c.permissions.holds('manage_agents', agent.organization_id)) return false;

        // Agent Editor restriction: cannot modify unpublished drafts from others
        const orgRole = c.user ? c.user.orgRole : null;
        if (orgRole === OrgRoles.AGENT_EDITOR && !agent.is_published) {
            return false;
        }

        return true;
    }

    return { buildCanModifyContext, canModifyAgent };
}

let defaultInstance = null;

/** The instance for code that has no router of its own: the real auth and user store, required lazily. */
function defaultAgentAccess() {
    if (!defaultInstance) {
        defaultInstance = makeAgentAccess({
            resolvePermissionsByOrg: (userId, session) => require('../auth/permissions').resolvePermissionsByOrg(userId, session),
            resolveUserOrgIds: (req) => require('../auth/permissions').resolveUserOrgIds(req),
            getUser: (id) => require('../stores/userStore').getUser(id),
            roles: () => {
                const { SystemRoles, OrgRoles } = require('../auth/permissions');
                return { SystemRoles, OrgRoles };
            },
        });
    }
    return defaultInstance;
}

module.exports = { makeAgentAccess, defaultAgentAccess };
