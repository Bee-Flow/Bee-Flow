// @typecheck strict
/**
 * Shared helpers for the AI config routers in this directory: the admin gate
 * every admin-only route checks.
 *
 * Org-id resolution lives in `auth/orgScope.js`, not in a private copy here —
 * a copy would answer the same question as three other helpers without any
 * of them having to agree.
 */

const { hasPermission } = require('../../../auth/permissions');

/** @param {import('express').Request} req */
async function isAdminUser(req) {
    if (req.session.isAdmin || req.session.user?.role === 'admin') return true;
    const userId = req.session.user?.id;
    if (!userId) return false;
    return await hasPermission(userId, 'admin_ai_config', req.session);
}

module.exports = { isAdminUser };
