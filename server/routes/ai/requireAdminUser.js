/**
 * The admin gate of the AI admin routes: a middleware that answers
 * 403 'Admin access required' unless `isAdminUser(req)` says yes.
 *
 * The predicate is passed in rather than required here, so each router keeps
 * the one it imports itself (config/shared.isAdminUser for most of them,
 * localRuntimes its own null-safe copy) and the tests that double that import
 * still reach the real gate.
 *
 * @param {(req: import('express').Request) => Promise<boolean>} isAdminUser
 * @returns {import('express').RequestHandler}
 */
function requireAdminUser(isAdminUser) {
    return async function requireAdmin(req, res, next) {
        if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
        next();
    };
}

module.exports = { requireAdminUser };
