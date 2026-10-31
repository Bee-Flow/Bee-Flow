// @typecheck strict
/**
 * The gate of settings that are INSTANCE-wide: LLM providers and their keys,
 * the Privacy Shield defaults every organisation falls back to, the guard
 * installer, platform branding, operational metrics.
 *
 * Two deployment shapes, one rule:
 *   - self-hosted: the install IS one customer, so an admin permission that
 *     the organisation's roles grant (admin_ai_config, admin_security,
 *     manage_users) is the right bar: the permission each of these routes
 *     checks. Behaviour there is the permission check alone.
 *   - any other mode (cloud): organisations are tenants of a shared instance,
 *     and an org-level role must not reach instance-wide state. Only a
 *     platform admin (the super-admin session flag or the `admin` user role)
 *     passes.
 *
 * Same shape as orgAzureConfig's platformConfigGate, generalised over the
 * permission so each router keeps the one it always checked.
 *
 * Built by the permissions.js barrel with the real collaborators (the split
 * modules of the barrel are not required from here: see permissionsDeps.js);
 * a test builds it with its own.
 */

const { tagGate } = require('./gateMeta');

/**
 * @typedef {{
 *   hasPermission: (userId: string, permission: string, session?: import('express').Request['session']) => Promise<boolean>,
 *   isSuperAdmin: (req: import('express').Request) => boolean,
 *   deploymentMode?: () => string,
 * }} PlatformAdminDeps `deploymentMode` defaults to license.deploymentMode, required at call time
 */

/**
 * @param {PlatformAdminDeps} deps
 */
function createPlatformAdminGate({ hasPermission, isSuperAdmin, deploymentMode }) {
    // Lazy by default: license/index pulls the licence store and tiers, which
    // the auth layer must not load at require time (see orgAzureConfig's gate).
    const mode = deploymentMode || (() => require('../license').deploymentMode());

    /**
     * Whether the caller may change instance-wide settings guarded by `permission`.
     * @param {import('express').Request} req
     * @param {string} permission the org-level permission that suffices on a self-hosted install
     * @returns {Promise<boolean>}
     */
    async function hasPlatformAdminAccess(req, permission) {
        if (isSuperAdmin(req)) return true;
        if (mode() !== 'self-hosted') return false;
        const userId = req.session?.user?.id;
        if (!userId) return false;
        return hasPermission(userId, permission, req.session);
    }

    /**
     * Middleware form: 401 without a session, 403 unless hasPlatformAdminAccess.
     * The 403 body matches the AI admin routers' existing refusal so no client
     * has to learn a new message.
     * @param {string} permission
     * @returns {import('express').RequestHandler}
     */
    function requirePlatformAdmin(permission) {
        return tagGate(async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            if (await hasPlatformAdminAccess(req, permission)) return next();
            return res.status(403).json({ error: 'Admin access required' });
        }, { axis: 'rbac', anyOf: [permission, 'all'], platform: true });
    }

    return { hasPlatformAdminAccess, requirePlatformAdmin };
}

module.exports = { createPlatformAdminGate };
