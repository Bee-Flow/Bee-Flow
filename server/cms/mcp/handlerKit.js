// @typecheck noImplicitAny
'use strict';
/**
 * Small pieces every CMS-over-MCP handler module shares (./dispatch.js and
 * its handler factories): the error-result shape, the object test, and the
 * per-user rate budget.
 */

/**
 * @typedef {Record<string, any>} ToolArgs  the arguments of one tool call (JSON from the MCP client)
 * @typedef {{ user: Record<string, any>, userId: string, orgId: string|null, token: { name: string, scopes: Record<string, any>, id?: string, legacy?: boolean }, baseUrl?: string }} McpCtx  who is calling
 * @typedef {ReturnType<typeof import('./siteContext').createSiteContext>} SiteContext
 * @typedef {{ deps: import('./dispatch').CmsMcpDeps, cmsStore: Record<string, any>, live: import('./dispatch').CmsMcpDeps['live'], resolveSite: SiteContext['resolveSite'], loadDraft: SiteContext['loadDraft'], validationOf: SiteContext['validationOf'] }} HandlerKit  what dispatch hands every handler factory
 */

/** @param {unknown} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
const err = (error, extra = {}) => ({ result: { error, ...extra } });

/**
 * A fixed-window per-user budget over a Map (userId → { count, resetAt }).
 * @param {() => number} now
 */
function createTakeBudget(now) {
    /**
     * @param {Map<string, { count: number, resetAt: number }>} budget
     * @param {string} userId
     * @param {number} max
     * @param {number} windowMs
     */
    function takeBudget(budget, userId, max, windowMs) {
        const t = now();
        const entry = budget.get(userId);
        if (!entry || entry.resetAt <= t) {
            budget.set(userId, { count: 1, resetAt: t + windowMs });
            return true;
        }
        if (entry.count >= max) return false;
        entry.count += 1;
        return true;
    }
    return takeBudget;
}

module.exports = { isPlainObject, err, createTakeBudget };
