// @typecheck strict
/**
 * The admin gate of the AI admin routes: a middleware that answers
 * 403 'Admin access required' unless `isAdminUser(req)` says yes.
 *
 * Everything these routes write is instance-wide, and the predicate every
 * router passes is the platform-admin test (config/shared.isAdminUser, which
 * is auth/requirePlatformAdmin's hasPlatformAdminAccess; localRuntimes its own
 * null-safe copy of the same call). The middleware is tagged on the platform
 * axis, so the route contract reads these routes as platform-class.
 *
 * The predicate is passed in rather than required here, so each router keeps
 * the one it imports itself and the tests that double that import still reach
 * the real gate.
 */

const { tagGate } = require('../../auth/gateMeta');
const { PLATFORM_GATE } = require('../../auth/requirePlatformAdmin');

/**
 * @param {(req: import('express').Request) => Promise<boolean>} isAdminUser
 * @returns {import('express').RequestHandler}
 */
function requireAdminUser(isAdminUser) {
    /** @type {import('express').RequestHandler} */
    async function requireAdmin(req, res, next) {
        if (!(await isAdminUser(req))) {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }
        next();
    }
    return tagGate(requireAdmin, PLATFORM_GATE);
}

module.exports = { requireAdminUser };
