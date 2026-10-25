// @typecheck strict
/**
 * Permissions, Middleware & Config
 *
 * RBAC system with group/role resolution, middleware factories,
 * and auth config load/save via configStore.
 *
 * Studio authorization helpers:
 *   - assertUserCanUseOrg(req, orgId)   — validates that the requesting user
 *     belongs to `orgId` (or defaults to their primary org if omitted). Use
 *     on every create endpoint that accepts `organizationId` from the body.
 *   - validateSharedGroupsForOrg(orgId, ids, opts) — confirms every supplied
 *     group ID belongs to `orgId`. Use on every publish/share endpoint that
 *     mutates `shared_groups`. Pass `{requireNonEmpty: true}` when the caller
 *     asked for GROUP-scoped sharing specifically: an empty `shared_groups` on
 *     a published row means the WHOLE ORGANISATION, so handing [] back there
 *     would widen the audience while the person thought they narrowed it.
 *
 * Notes:
 *   - Automations (automations) are intentionally user-private and do not have
 *     `is_published` / `shared_groups` columns.
 *   - The legacy `knowledge_metadata` table (per-agent) is NOT the studio KB
 *     path. Studio KBs live in `knowledge_bases` and use the same
 *     org + is_published + shared_groups model as Agents and Webpages.
 *
 * This file is the public surface (a barrel). The code lives in:
 *   - permissionsCatalog.js     role + permission ids, SYSTEM_PERMISSIONS, the
 *                               capability-implied permissions, orgRoles.json
 *   - permissionsOAuth.js       OAuth providers, Microsoft scopes, auth config
 *   - permissionsCache.js       permission / user-exists caches, Redis pub/sub
 *                               invalidation (all cache state)
 *   - permissionsRequireAuth.js the session gate and the last-seen throttle
 *   - permissionsResolve.js     getUserPermissions, hasPermission, the RBAC
 *                               gates, resolveUserOrgIds
 *   - permissionsOrgGates.js    org-lifecycle, org-admin and super-admin gates
 *   - permissionsStudioScope.js assertUserCanUseOrg, validateSharedGroupsForOrg
 *   - permissionsDeps.js        the cycle-member collaborators, wired below
 * Callers (and routeHarness, which replaces exports by name) keep importing
 * this file; the modules call each other directly, exactly as the functions
 * did when they shared one file.
 *
 * No request schema lives here: this file declares gates, not routes. The one
 * body value it reads, `organizationId` in requireActiveOrg, can only ADD an
 * org to check (see there), and the route that mounts the gate owns the schema.
 */

// The collaborators in the server's big import cycle are required HERE and
// handed to the split modules (auth/permissionsDeps.js), so the cycle holds
// this file only. Same timing as before the split: userStore and orgScope when
// this file loads, the rest at call time.
const userStore = require('../stores/userStore');
const { orgScope } = require('./orgScope');
require('./permissionsDeps').wireDeps({
    userStore: () => userStore,
    orgScope: () => orgScope,
    userStoreNow: () => require('../stores/userStore'),
    microsoftSession: () => require('./microsoftSession'),
    orgRolePolicy: () => require('./orgRolePolicy'),
    authConfigStore: () => require('../stores/authConfigStore'),
});

const catalog = require('./permissionsCatalog');
const oauth = require('./permissionsOAuth');
const cache = require('./permissionsCache');
const { requireAuth } = require('./permissionsRequireAuth');
const resolve = require('./permissionsResolve');
const orgGates = require('./permissionsOrgGates');
const studioScope = require('./permissionsStudioScope');

module.exports = {
    SYSTEM_PERMISSIONS: catalog.SYSTEM_PERMISSIONS,
    getOrgRolePermissions: catalog.getOrgRolePermissions,
    OAUTH_PROVIDERS: oauth.OAUTH_PROVIDERS,
    MICROSOFT_SCOPES: oauth.MICROSOFT_SCOPES,
    microsoftRefreshScope: oauth.microsoftRefreshScope,
    loadConfig: oauth.loadConfig,
    saveConfig: oauth.saveConfig,
    requireAuth,
    getUserPermissions: resolve.getUserPermissions,
    resolveUserPermissionsForAudit: resolve.resolveUserPermissionsForAudit,
    hasPermission: resolve.hasPermission,
    requireAdmin: resolve.requireAdmin,
    requireSuperAdmin: orgGates.requireSuperAdmin,
    requirePermission: resolve.requirePermission,
    requirePluginAdmin: resolve.requirePluginAdmin,
    resolveUserOrgIds: resolve.resolveUserOrgIds,
    resolvePrimaryOrgId: orgGates.resolvePrimaryOrgId,
    isSuperAdmin: orgGates.isSuperAdmin,
    isSuperAdminUser: orgGates.isSuperAdminUser,
    isOrgAdminForOrg: orgGates.isOrgAdminForOrg,
    _evalOrgAdmin: orgGates._evalOrgAdmin,
    requireOrgAdmin: orgGates.requireOrgAdmin,
    requirePrimaryOrgAdmin: orgGates.requirePrimaryOrgAdmin,
    assertUserCanUseOrg: studioScope.assertUserCanUseOrg,
    validateSharedGroupsForOrg: studioScope.validateSharedGroupsForOrg,
    invalidatePermissionCache: cache.invalidatePermissionCache,
    invalidateAllPermissionCaches: cache.invalidateAllPermissionCaches,
    invalidateUserExistenceCache: cache.invalidateUserExistenceCache,
    GROUP_GRANT_IMPLIED_PERMISSIONS: catalog.GROUP_GRANT_IMPLIED_PERMISSIONS,
    orgWideGrantImpliedPermissions: catalog.orgWideGrantImpliedPermissions,
    orgRoleImpliedFill: catalog.orgRoleImpliedFill,
    OrgRoles: catalog.OrgRoles,
    SystemRoles: catalog.SystemRoles,
    Permissions: catalog.Permissions,
    ORG_ADMIN_VARIANTS: catalog.ORG_ADMIN_VARIANTS,
    isOrgAdminRole: catalog.isOrgAdminRole,
    requireActiveOrg: orgGates.requireActiveOrg,
    requireActiveOrgForMutations: orgGates.requireActiveOrgForMutations,
    isPermissionLookupDegraded: resolve.isPermissionLookupDegraded,
};
