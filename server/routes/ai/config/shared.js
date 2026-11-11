// @typecheck strict
/**
 * Shared helpers for the AI config routers in this directory: the admin gate
 * every admin-only route checks.
 *
 * Everything these routers write is instance-wide (providers, keys, the
 * Shield defaults every organisation falls back to), so the gate is
 * auth/requirePlatformAdmin: a platform admin, in every deployment mode. As
 * route middleware it is ../requireAdminUser (tagged on the platform axis);
 * a handler calls isAdminUser itself only where one route answers admins and
 * members differently (GET /config, GET /providers).
 *
 * Org-id resolution lives in `auth/orgScope.js`, not in a private copy here —
 * a copy would answer the same question as three other helpers without any
 * of them having to agree.
 */

const { hasPlatformAdminAccess } = require('../../../auth/permissions');

/** @param {import('express').Request} req */
async function isAdminUser(req) {
    return hasPlatformAdminAccess(req, 'admin_ai_config');
}

module.exports = { isAdminUser };
