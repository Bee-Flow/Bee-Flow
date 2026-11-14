// @typecheck strict
/**
 * What GET /api/org-azure-config/:orgId/sync-groups/status answers an
 * organisation admin (routes/orgAzureConfig.js): the organisation's own group
 * sync (its last run and its settings) and whether a directory is connected for
 * it. The directory connection itself (tenant, application, secret) is the
 * platform's and stays behind the platform gate of GET /:orgId, so this view is
 * built from an explicit list of fields and carries no configuration value.
 */

const { GUID } = require('../auth/microsoftIdentity');

/**
 * `directoryConfigured`: the platform's Microsoft application has an id and a secret, the sync is bound
 * to this organisation with a directory GUID, and the sign-in tenant does not contradict it (the
 * conditions syncAzureGroupsToOrg checks before it reads the directory).
 * @typedef {{
 *   directoryConfigured: boolean,
 *   status: { lastSyncAt: string | null, lastSyncResult: string | null, syncedGroups: number, syncedUsers: number, errorCount: number },
 *   settings: { destructiveSync: boolean, autoActivateUsers: boolean, periodicSync: boolean, syncIntervalHours: number },
 * }} GroupSyncView
 */

/** @param {unknown} v */
const textOrNull = (v) => (typeof v === 'string' && v ? v : null);
/** @param {unknown} v */
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * @param {{
 *   orgId: string,
 *   status: Record<string, unknown> | null | undefined,
 *   settings: Record<string, unknown> | null | undefined,
 *   binding: { syncOrganizationId?: unknown, syncTenantId?: unknown } | null | undefined,
 *   microsoft: { clientId?: unknown, clientSecret?: unknown, tenantId?: unknown } | null | undefined,
 * }} input
 * @returns {GroupSyncView}
 */
function groupSyncView({ orgId, status, settings, binding, microsoft }) {
    const st = status || {};
    const se = settings || {};
    const ms = microsoft || {};
    const boundTenant = typeof binding?.syncTenantId === 'string' ? binding.syncTenantId : '';
    const bound = binding?.syncOrganizationId === orgId && GUID.test(boundTenant);
    const signInTenant = typeof ms.tenantId === 'string' ? ms.tenantId : '';
    const tenantAgrees = !GUID.test(signInTenant) || signInTenant.toLowerCase() === boundTenant;
    return {
        directoryConfigured: !!ms.clientId && !!ms.clientSecret && bound && tenantAgrees,
        status: {
            lastSyncAt: textOrNull(st.lastSyncAt),
            lastSyncResult: textOrNull(st.lastSyncResult),
            syncedGroups: count(st.syncedGroups),
            syncedUsers: count(st.syncedUsers),
            errorCount: Array.isArray(st.errors) ? st.errors.length : 0,
        },
        settings: {
            destructiveSync: se.destructiveSync === true,
            autoActivateUsers: se.autoActivateUsers !== false,
            periodicSync: se.periodicSync === true,
            syncIntervalHours: count(se.syncIntervalHours) || 6,
        },
    };
}

module.exports = { groupSyncView };
