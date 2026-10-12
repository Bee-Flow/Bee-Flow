// @typecheck
/**
 * Which organisation(s) does an MCP caller belong to?
 *
 * The org policy has to bind EVERY member, and not every member has a home
 * org: an account can carry `organizationId === ''` and reach its tenant only
 * through a group (see auth/orgScope.js, which this mirrors: home org first,
 * then the orgs the user's groups belong to, in the order of the user's own
 * group list). Reading only `user.organizationId` let such a member skip the
 * policy altogether, because "no org" loads the open default.
 *
 * A user can belong to more than one org through groups. There is no way to
 * say which one a request is "for", so the gate evaluates the policy of
 * every one of them and the strictest wins: all must pass. The *primary* org
 * (home, else the first group org) is the one a token is minted for and the
 * one reported to the tools.
 *
 * Resolution that cannot be completed THROWS. The caller denies on a throw: a
 * failed group read must never fall back to "no org, no policy".
 */

'use strict';

/** @typedef {{ primary: string|null, all: string[] }} McpOrgs */

function groupIdsOf(user) {
    if (Array.isArray(user?.groups)) return user.groups;
    try { return JSON.parse(user?.groups || '[]'); } catch (_) { return []; }
}

const defaultDeps = {
    getAllGroups: () => require('../../stores/userStore').getAllGroups(),
};

/**
 * @param {{ organizationId?: string|null, groups?: unknown }|null|undefined} user
 * @param {{ getAllGroups?: () => Promise<any[]> }} [deps]
 * @returns {Promise<McpOrgs>}
 * @throws when the groups cannot be read
 */
async function resolveMcpOrgs(user, deps = {}) {
    const getAllGroups = deps.getAllGroups || defaultDeps.getAllGroups;
    /** @type {string[]} */
    const all = [];
    // Truthiness, never a null check: an org-less account holds the empty string.
    if (user?.organizationId) all.push(user.organizationId);

    const groupIds = groupIdsOf(user);
    if (groupIds.length > 0) {
        const groups = (await getAllGroups()) || [];
        for (const gid of groupIds) {
            const g = groups.find((x) => x && x.id === gid);
            if (g?.organizationId && !all.includes(g.organizationId)) all.push(g.organizationId);
        }
    }
    return { primary: all[0] ?? null, all };
}

/** The primary org id only (home, else the first group org, else null). */
async function resolveMcpOrgId(user, deps = {}) {
    return (await resolveMcpOrgs(user, deps)).primary;
}

module.exports = { resolveMcpOrgs, resolveMcpOrgId };
