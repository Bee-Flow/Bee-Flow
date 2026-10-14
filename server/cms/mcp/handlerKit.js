'use strict';
/**
 * Small pieces every CMS-over-MCP handler module shares (./dispatch.js and
 * its handler factories): the error-result shape, the object test, and the
 * per-user rate budget.
 */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const err = (error, extra = {}) => ({ result: { error, ...extra } });

/**
 * A fixed-window per-user budget over a Map (userId → { count, resetAt }).
 * @param {() => number} now
 */
function createTakeBudget(now) {
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
