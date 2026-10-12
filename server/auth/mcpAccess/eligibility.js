/**
 * Which MCP servers may THIS user put on a token?
 *
 * A token never grants more than the person who creates it can do. The gate
 * re-checks entitlement on every call (defence in depth); this module is the
 * same question asked up front, so the create form can show what is on offer
 * and POST /api/mcp-tokens can refuse a scope its creator does not hold.
 *
 *   {
 *     policy:       { allowed, reason? },            // the org policy, strictest org wins
 *     integrations: { available, reason? },
 *     automations:  { available, reason? },
 *     studio:       { available, canWrite?, reason? },
 *     cms:          { available, canPublish, reason? },
 *   }
 *
 * reason: 'not_enabled' (the operator's env flag is off; the UI hides the
 * server) or 'no_access' (the user lacks the right to it). For the policy:
 * 'disabled' (the org switched MCP off), 'user_not_allowed' or 'unavailable'
 * (the policy or the user's orgs could not be read: refused, never waved
 * through).
 *
 * This file lives in auth/ and so may not reach into routes/ or the features.
 * The per-server predicates are therefore INJECTED (`deps.servers`); the one
 * production wiring is routes/mcpTokens.js, which hands in the very functions
 * the three MCP routers use. A server with no predicate counts as not enabled.
 *
 * Any failure to find out is a refusal: an entitlement lookup that throws is
 * `no_access`, never availability.
 */

'use strict';

const { resolveMcpOrgs } = require('./orgResolve');
const { getOrgMcpPolicy, userAllowedByPolicy } = require('./orgPolicy');
const log = require('../../telemetry/log');

/**
 * @typedef {{ enabled: () => boolean, entitled?: (userId: string) => Promise<boolean>, isAdmin?: (user: any) => Promise<boolean> }} ServerCheck
 * @typedef {{
 *   resolveOrgs?: (user: any) => Promise<{ primary: string|null, all: string[] }>,
 *   getOrgMcpPolicy?: (orgId: string|null) => Promise<any>,
 *   servers?: { automations?: ServerCheck, studio?: ServerCheck, cms?: ServerCheck },
 * }} EligibilityDeps
 */

/** @param {any} user @param {EligibilityDeps} deps */
async function policyDecision(user, deps) {
    try {
        const orgs = await (deps.resolveOrgs || resolveMcpOrgs)(user);
        const load = deps.getOrgMcpPolicy || getOrgMcpPolicy;
        const policies = orgs.all.length > 0
            ? await Promise.all(orgs.all.map((orgId) => load(orgId)))
            : [await load(null)];
        // The strictest org wins: one refusal is a refusal.
        for (const policy of policies) {
            if (!policy || policy.enabled === false) return { allowed: false, reason: 'disabled' };
            if (!userAllowedByPolicy(policy, user)) return { allowed: false, reason: 'user_not_allowed' };
        }
        return { allowed: true };
    } catch (err) {
        log.warn(`[McpAccess] eligibility: policy could not be read for user=${user?.id}: ${err.message}`);
        return { allowed: false, reason: 'unavailable' };
    }
}

/** True / false for "may this user", false on any error. */
async function attempt(label, userId, fn) {
    try {
        return (await fn()) === true;
    } catch (err) {
        log.warn(`[McpAccess] eligibility: ${label} check failed for user=${userId}: ${err.message}`);
        return false;
    }
}

/**
 * @param {{ id: string }} user the caller, read fresh (groups, role)
 * @param {EligibilityDeps} [deps]
 */
async function eligibleServers(user, deps = {}) {
    const servers = deps.servers || {};
    const userId = user?.id;
    const off = { available: false, reason: 'not_enabled' };
    const noAccess = { available: false, reason: 'no_access' };

    const [policy, automations, studio, cms] = await Promise.all([
        policyDecision(user, deps),
        (async () => {
            const s = servers.automations;
            if (!s || !s.enabled()) return { ...off };
            return (await attempt('automations', userId, () => s.entitled(userId))) ? { available: true } : { ...noAccess };
        })(),
        (async () => {
            const s = servers.studio;
            if (!s || !s.enabled()) return { ...off };
            // App Studio has one licence capability for building; there is no
            // separate read right, so writing is exactly as available as reading.
            return (await attempt('studio', userId, () => s.entitled(userId)))
                ? { available: true, canWrite: true }
                : { ...noAccess, canWrite: false };
        })(),
        (async () => {
            const s = servers.cms;
            if (!s || !s.enabled()) return { ...off, canPublish: false };
            // Only CMS admins use the CMS tools at all, and they may publish.
            return (await attempt('cms', userId, () => s.isAdmin(user)))
                ? { available: true, canPublish: true }
                : { ...noAccess, canPublish: false };
        })(),
    ]);

    // The integration tools (mail, calendar, ...) check each tool's own
    // connection when called; the server itself is open to any account.
    return { policy, integrations: { available: true }, automations, studio, cms };
}

const SERVER_LABELS = Object.freeze({
    integrations: 'your connected apps (mail, calendar and so on)',
    automations: 'Automations',
    studio: 'App Studio',
    cms: 'the website editor',
});

/**
 * The first requested server this user may not put on a token, as
 * `{ server, why }`, or null when all are fine. Also checks the levels the
 * eligibility object limits: studio write, cms publish.
 *
 * @param {Record<string, any>} scopes normalised
 * @param {Awaited<ReturnType<typeof eligibleServers>>} eligibility
 */
function firstRefusedScope(scopes, eligibility) {
    for (const server of Object.keys(scopes)) {
        const e = eligibility[server];
        if (!e || !e.available) {
            return { server, label: SERVER_LABELS[server] || server, why: e?.reason === 'not_enabled' ? 'not_enabled' : 'no_access' };
        }
        if (server === 'studio' && scopes[server].level === 'write' && e.canWrite === false) {
            return { server, label: SERVER_LABELS.studio, why: 'no_access' };
        }
        if (server === 'cms' && scopes[server].publish === true && e.canPublish === false) {
            return { server, label: SERVER_LABELS.cms, why: 'no_access', publish: true };
        }
    }
    return null;
}

module.exports = { eligibleServers, firstRefusedScope, SERVER_LABELS };
