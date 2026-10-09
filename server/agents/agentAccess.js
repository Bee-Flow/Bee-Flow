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

/**
 * @param {{
 *   hasPermission: (userId: string, permission: string, session?: any) => Promise<boolean>,
 *   resolveUserOrgIds: (req: any) => Promise<Set<string>|null>,
 *   getUser: (userId: string) => Promise<any>,
 *   roles: () => { SystemRoles: { SUPER_ADMIN: string }, OrgRoles: { AGENT_EDITOR: string } },
 * }} deps
 */
function makeAgentAccess(deps) {
    // Prefetch the per-request inputs canModifyAgent needs so list endpoints can
    // compute `can_edit` for many agents without N× user/permission lookups.
    async function buildCanModifyContext(userId, req) {
        if (!userId) return { hasManage: false, orgIds: new Set(), user: null };
        const [hasManage, orgIds, user] = await Promise.all([
            deps.hasPermission(userId, 'manage_agents', req.session),
            Promise.resolve(deps.resolveUserOrgIds(req)).catch(() => new Set()),
            Promise.resolve(deps.getUser(userId)).catch(() => null),
        ]);
        return { hasManage, orgIds, user };
    }

    // The single authoritative per-agent write gate. Rules in order:
    //   1. Owners may always modify their own agent (checked FIRST — owners
    //      without manage_agents must keep their publish/knowledge flows).
    //   2. Super-admins may modify anything.
    //   3. Everyone else needs the manage_agents permission AND membership in the
    //      agent's organization. (BFSF-271: previously ANY manage_agents holder
    //      passed, including users from other orgs — a cross-org IDOR.)
    //   4. Org-less agents (system/swarm/personal drafts) are owner/super-admin only.
    //   5. Agent Editors cannot modify unpublished drafts from others.
    // `ctx` (optional) is a buildCanModifyContext() result for list endpoints.
    async function canModifyAgent(agent, userId, req, ctx = null) {
        if (agent.owner_id === userId) return true;

        const { SystemRoles, OrgRoles } = deps.roles();

        // Super admin bypass
        if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return true;

        const c = ctx || await buildCanModifyContext(userId, req);

        // Non-owners always need manage_agents. Previously enforced ad-hoc by
        // (most) callers; centralised here so every caller inherits it.
        if (!c.hasManage) return false;

        // Org scoping: the requester must belong to the agent's organization.
        // Org-less agents have no org to scope by → owner/super-admin only.
        if (!agent.organization_id) return false;
        // resolveUserOrgIds returns null only for super-admins (handled above);
        // keep the null-guard so a degenerate ctx can never widen access.
        if (c.orgIds === null || !c.orgIds.has(agent.organization_id)) return false;

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
            hasPermission: (...a) => require('../auth').hasPermission(...a),
            resolveUserOrgIds: (req) => require('../auth').resolveUserOrgIds(req),
            getUser: (id) => require('../stores/userStore').getUser(id),
            roles: () => {
                const { SystemRoles, OrgRoles } = require('../auth');
                return { SystemRoles, OrgRoles };
            },
        });
    }
    return defaultInstance;
}

module.exports = { makeAgentAccess, defaultAgentAccess };
