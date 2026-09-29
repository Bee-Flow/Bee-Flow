/**
 * Shared helpers for the AI config routers in this directory: the admin gate
 * every admin-only route checks.
 *
 * Org-id resolution used to live here as a private copy. It is
 * `auth/orgScope.js` now — the copy answered the same question as three other
 * helpers and none of them had to agree.
 */

const { hasPermission } = require('../../../auth/permissions');

async function isAdminUser(req) {
    if (req.session.isAdmin || req.session.user?.role === 'admin') return true;
    const userId = req.session.user?.id;
    if (!userId) return false;
    return await hasPermission(userId, 'admin_ai_config', req.session);
}

module.exports = { isAdminUser };
