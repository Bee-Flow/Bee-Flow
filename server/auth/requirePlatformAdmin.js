// @typecheck strict
/**
 * The gate of settings that are INSTANCE-wide: LLM providers and their keys,
 * the Privacy Shield defaults every organisation falls back to, the guard
 * installer, platform branding, operational metrics.
 *
 * One rule, in every deployment mode: only a platform admin passes (the
 * super-admin session flag or the `admin` user role, auth/permissionsOrgGates
 * isSuperAdmin). An organisation role or permission never reaches
 * instance-wide state, on a self-hosted install as much as on a shared one:
 * one server can hold many organisations, and an admin of one of them is not
 * the operator of the server. State that belongs to ONE organisation has its
 * own gate, the org-admin check for that organisation
 * (permissionsOrgGates.isOrgAdminForOrg).
 *
 * The `permission` argument is the permission the route's organisation-level
 * counterpart uses; it is kept so every call site reads as before, and it
 * admits nobody. The middleware is tagged on the platform axis, so the route
 * contract (auth/routeContract.js) and the access-registry drift test read it
 * as the platform gate it is.
 *
 * Built by the permissions.js barrel with the real isSuperAdmin (the split
 * modules of the barrel are not required from here: see permissionsDeps.js);
 * a test builds it with its own.
 */

const { tagGate } = require('./gateMeta');

/**
 * The tag every platform-admin gate carries: the same axis and kind as
 * requireSuperAdmin, whose decision it is.
 */
const PLATFORM_GATE = Object.freeze({ axis: 'platform', kind: 'superAdmin' });

/**
 * @typedef {{
 *   isSuperAdmin: (req: import('express').Request) => boolean,
 * }} PlatformAdminDeps
 */

/**
 * @param {PlatformAdminDeps} deps
 */
function createPlatformAdminGate({ isSuperAdmin }) {
    /**
     * Whether the caller may change instance-wide settings: a platform admin only.
     * @param {import('express').Request} req
     * @param {string} [_permission] the organisation-level permission of the call site; it admits nobody
     * @returns {Promise<boolean>}
     */
    async function hasPlatformAdminAccess(req, _permission) {
        return isSuperAdmin(req);
    }

    /**
     * Middleware form: 401 without a session, 403 unless a platform admin.
     * The 403 body matches the AI admin routers' existing refusal so no client
     * has to learn a new message.
     * @param {string} [_permission] the organisation-level permission of the call site; it admits nobody
     * @returns {import('express').RequestHandler}
     */
    function requirePlatformAdmin(_permission) {
        return tagGate(async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            if (await hasPlatformAdminAccess(req)) return next();
            return res.status(403).json({ error: 'Admin access required' });
        }, PLATFORM_GATE);
    }

    return { hasPlatformAdminAccess, requirePlatformAdmin };
}

module.exports = { createPlatformAdminGate, PLATFORM_GATE };
