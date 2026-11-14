// @typecheck
'use strict';

const { isMemberOfOrg } = require('../auth/orgMembership');
const { GUID } = require('../auth/microsoftIdentity');
const { forbidden, unavailable } = require('../core/http/errors');
const { getClientCredentialsToken, graphGet, getAppRoleAssignments, getGroupMembers } = require('./azureGraph');
const { syncDirectory } = require('./azureGroupSyncSteps');
const DEFAULT_SYNC_SETTINGS = { destructiveSync: false, autoActivateUsers: true, periodicSync: false, syncIntervalHours: 6 };

function createAzureGroupSync({ userStore, configStore, loadConfig, withSyncLock, membershipStore, findUnboundIdentity, log,
    graph = { getClientCredentialsToken, graphGet, getAppRoleAssignments, getGroupMembers } }) {
const { getClientCredentialsToken, graphGet, getAppRoleAssignments, getGroupMembers } = graph;
const syncTimers = new Map();
async function getSyncBinding() {
    return await configStore.getConfigFresh('azure_group_sync_binding');
}
async function assertSyncBinding(orgId, tenantId) {
    const binding = await getSyncBinding();
    if (!binding?.syncOrganizationId || !GUID.test(binding.syncTenantId || '')) {
        throw unavailable('azure_sync_unbound', 'A platform administrator must configure the Azure sync organization and tenant first.');
    }
    if (orgId !== binding.syncOrganizationId || (tenantId && tenantId !== binding.syncTenantId)) {
        throw forbidden('azure_sync_wrong_organization', 'This Azure directory is bound to a different organization or tenant.');
    }
    return binding;
}
async function getSyncSettings(orgId) {
    return { ...DEFAULT_SYNC_SETTINGS, ...await configStore.getConfig(`azure_group_sync_${orgId}`) };
}
async function getSyncStatus(orgId) {
    return await configStore.getConfig(`azure_group_sync_status_${orgId}`) || { lastSyncAt: null, lastSyncResult: null, syncedGroups: 0, syncedUsers: 0, errors: [] };
}
async function setSyncSettings(orgId, patch) {
    await assertSyncBinding(orgId);
    const settings = { ...await getSyncSettings(orgId), ...patch };
    await configStore.setConfig(`azure_group_sync_${orgId}`, settings);
    if (settings.periodicSync) startPeriodicSync(orgId, settings.syncIntervalHours);
    else stopPeriodicSync(orgId);
    return settings;
}

async function syncAzureGroupsToOrg(orgId) {
    await assertSyncBinding(orgId);
    // A database lock serializes all replicas, not just this Node process.
    return withSyncLock(async () => {
        const binding = await assertSyncBinding(orgId);
        const tenantId = binding.syncTenantId;
        const settings = await getSyncSettings(orgId);
        const run = { orgId, tenantId, settings, details: [], errors: [], syncedGroups: 0, syncedUsers: 0, allGroups: [], managed: [] };
        try {
            await syncDirectory({ userStore, membershipStore, findUnboundIdentity, loadConfig,
                graph: { getClientCredentialsToken, graphGet, getAppRoleAssignments, getGroupMembers } }, run);
        } catch (err) { run.errors.push(err.message); }
        const { details, errors, syncedGroups, syncedUsers } = run;
        const status = { lastSyncAt: new Date().toISOString(), lastSyncResult: errors.length ? 'partial' : 'success', syncedGroups, syncedUsers, errors };
        await configStore.setConfig(`azure_group_sync_status_${orgId}`, status);
        return { ok: !errors.length, synced: { groups: syncedGroups, users: syncedUsers }, details, errors };
    });
}
function stopPeriodicSync(orgId) {
    clearInterval(syncTimers.get(orgId)); syncTimers.delete(orgId);
}
function stopAllPeriodicSyncs() { for (const orgId of syncTimers.keys()) stopPeriodicSync(orgId); }
function startPeriodicSync(orgId, hours) {
    stopPeriodicSync(orgId);
    const timer = setInterval(() => syncAzureGroupsToOrg(orgId).catch(err => log.warn('[AzureGroupSync]', err.message)), hours * 3600000);
    timer.unref(); syncTimers.set(orgId, timer);
}
async function initPeriodicSyncs() {
    const binding = await getSyncBinding();
    if (!binding?.syncOrganizationId || !GUID.test(binding.syncTenantId || '')) {
        stopAllPeriodicSyncs();
        log.warn('[AzureGroupSync]', 'Synchronization is disabled: confirm one organization and a concrete tenant in platform settings.');
        return;
    }
    const orgId = binding.syncOrganizationId;
    const settings = await getSyncSettings(orgId);
    if (!settings.periodicSync) return;
    startPeriodicSync(orgId, settings.syncIntervalHours);
    const status = await getSyncStatus(orgId);
    if (!status.lastSyncAt || Date.now() - Date.parse(status.lastSyncAt) > settings.syncIntervalHours * 3600000) await syncAzureGroupsToOrg(orgId);
}
function start(delayMs = 5000) {
    const timer = setTimeout(() => initPeriodicSyncs().catch(err => log.warn('[AzureGroupSync]', err.message)), delayMs);
    timer.unref(); return timer;
}
async function syncUserGroupsOnLogin(userId, oid, orgId, tenantId) {
    try {
        await withSyncLock(async () => {
        orgId ||= (await getSyncBinding())?.syncOrganizationId;
        const binding = await assertSyncBinding(orgId, tenantId);
        if (!tenantId || binding.syncTenantId !== tenantId) return;
        const user = await userStore.getUser(userId);
        const groups = await userStore.getAllGroups();
        if (!user || user.azureTenantId !== tenantId || user.azureUserId !== oid || !isMemberOfOrg(user, groups, orgId)) return;
        const ms = (await loadConfig()).providers.microsoft || {};
        const token = await getClientCredentialsToken(ms.clientId, ms.clientSecret, tenantId);
        const snapshot = [];
        for (const group of groups.filter(g => g.source === 'azure' && g.organizationId === orgId && g.azureTenantId === tenantId)) {
            snapshot.push({ group, member: (await getGroupMembers(token, group.azureGroupId)).some(m => typeof m.id === 'string' && m.id.toLowerCase() === oid.toLowerCase()) });
        }
        const settings = await getSyncSettings(orgId);
        for (const { group, member } of snapshot) {
            if (member) await membershipStore.add(userId, group, oid);
            else if (settings.destructiveSync) await membershipStore.remove(userId, group, oid);
        }
        });
    } catch (err) { log.warn('[AzureGroupSync/Login]', err.message); }
}
return { syncAzureGroupsToOrg, getSyncSettings, setSyncSettings, getSyncStatus,
    syncUserGroupsOnLogin, getSyncBinding, assertSyncBinding, getClientCredentialsToken,
    start, initPeriodicSyncs, stopAllPeriodicSyncs };

}
let instance;
function defaultSync() {
    return instance ||= createAzureGroupSync({ userStore: require('../stores/userStore'), configStore: require('../stores/configStore'),
        loadConfig: require('../auth/permissions').loadConfig, withSyncLock: require('./azureSyncLock').withAzureSyncLock,
        findUnboundIdentity: require('../stores/microsoftIdentityStore').findUnboundIdentity,
        membershipStore: require('../stores/azureSyncMembershipStore'), log: require('../telemetry/log') });
}
module.exports = { createAzureGroupSync, getClientCredentialsToken,
    syncAzureGroupsToOrg: (...args) => defaultSync().syncAzureGroupsToOrg(...args),
    getSyncSettings: (...args) => defaultSync().getSyncSettings(...args),
    setSyncSettings: (...args) => defaultSync().setSyncSettings(...args),
    getSyncStatus: (...args) => defaultSync().getSyncStatus(...args),
    syncUserGroupsOnLogin: (...args) => defaultSync().syncUserGroupsOnLogin(...args),
    getSyncBinding: (...args) => defaultSync().getSyncBinding(...args),
    assertSyncBinding: (...args) => defaultSync().assertSyncBinding(...args),
    start: (...args) => defaultSync().start(...args),
    initPeriodicSyncs: (...args) => defaultSync().initPeriodicSyncs(...args),
    stopAllPeriodicSyncs: (...args) => defaultSync().stopAllPeriodicSyncs(...args),
};

/** @typedef {ReturnType<typeof createAzureGroupSync>} AzureGroupSync */
