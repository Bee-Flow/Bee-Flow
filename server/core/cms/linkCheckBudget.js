// @typecheck
/**
 * One budget for the external link check, shared by the admin route and the
 * CMS MCP tool: a user gets EXTERNAL_MAX_PER_WINDOW runs per window in total,
 * however the runs are started. In memory and per replica, like the other
 * per-user limits.
 */

'use strict';

const EXTERNAL_MAX_PER_WINDOW = 5;
const EXTERNAL_WINDOW_MS = 10 * 60 * 1000;

/** @type {Map<string, { count: number, resetAt: number }>} */
const runs = new Map();

/**
 * @param {string} userId
 * @param {number} [now]
 * @returns {boolean} false when the user has used up the window
 */
function takeExternalRun(userId, now = Date.now()) {
    const entry = runs.get(userId);
    if (!entry || entry.resetAt <= now) {
        runs.set(userId, { count: 1, resetAt: now + EXTERNAL_WINDOW_MS });
        return true;
    }
    if (entry.count >= EXTERNAL_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
}

module.exports = { takeExternalRun, EXTERNAL_MAX_PER_WINDOW, EXTERNAL_WINDOW_MS };
