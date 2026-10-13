// @typecheck
/**
 * Auth Module — Entry Point
 *
 * Re-exports the auth middleware and helpers (auth/permissions.js,
 * auth/audience.js) for the modules that import them as `require('../auth')`.
 *
 * The /auth router itself lives in auth/router.js and is mounted by
 * server/index.js only. Requiring this file loads NO route file: `router`
 * below is a lazy getter kept for backward compatibility, and touching it is
 * what loads the routers (auth/router.test.js guards both). New code needing
 * a gate imports auth/permissions.js or auth/audience.js directly.
 */

const {
    requireAuth,
    requireAdmin,
    requireSuperAdmin,
    requirePermission,
    requirePluginAdmin,
    hasPermission,
    getUserPermissions,
    resolveUserOrgIds,
    resolvePrimaryOrgId,
    isSuperAdmin,
    requireOrgAdmin,
    requirePrimaryOrgAdmin,
    assertUserCanUseOrg,
    validateSharedGroupsForOrg,
    invalidatePermissionCache,
    invalidateAllPermissionCaches,
    OrgRoles,
    SystemRoles,
    Permissions,
    ORG_ADMIN_VARIANTS,
    isOrgAdminRole,
    requireActiveOrg,
    requireActiveOrgForMutations,
} = require('./permissions');
const {
    canSeePublished,
    resolveUserGroups,
    resolveAudienceContext,
} = require('./audience');

module.exports = {
    requireAuth,
    requireAdmin,
    requireSuperAdmin,
    requirePermission,
    requirePluginAdmin,
    hasPermission,
    getUserPermissions,
    resolveUserOrgIds,
    resolvePrimaryOrgId,
    isSuperAdmin,
    requireOrgAdmin,
    requirePrimaryOrgAdmin,
    assertUserCanUseOrg,
    validateSharedGroupsForOrg,
    invalidatePermissionCache,
    invalidateAllPermissionCaches,
    canSeePublished,
    resolveUserGroups,
    resolveAudienceContext,
    OrgRoles,
    SystemRoles,
    Permissions,
    ORG_ADMIN_VARIANTS,
    isOrgAdminRole,
    requireActiveOrg,
    requireActiveOrgForMutations,
};

// Lazy, so requiring this facade never loads the auth route files. Defined
// after the object literal so every other key stays a plain, writable data
// property (the route harness openGates, testUtils/routeHarness.js, and tests
// patch them).
Object.defineProperty(module.exports, 'router', {
    enumerable: true,
    configurable: true,
    get: () => require('./router'),
});
