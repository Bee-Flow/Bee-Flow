'use strict';

const { isMemberOfOrg } = require('../auth/orgMembership');
const { GUID } = require('../auth/microsoftIdentity');
const { forbidden, unavailable } = require('../core/http/errors');
const { getClientCredentialsToken, graphGet, getAppRoleAssignments, getGroupMembers } = require('./azureGraph');
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
        const details = [], errors = [];
        let syncedGroups = 0, syncedUsers = 0;
        try {
            const ms = (await loadConfig()).providers.microsoft || {};
            if (!ms.clientId || !ms.clientSecret) throw new Error('Configure Microsoft SSO credentials first');
            if (GUID.test(ms.tenantId || '') && ms.tenantId.toLowerCase() !== tenantId) throw new Error('Azure sync tenant differs from the Microsoft SSO tenant');
            const token = await getClientCredentialsToken(ms.clientId, ms.clientSecret, tenantId);
            const assignments = (await getAppRoleAssignments(token, ms.clientId)).map(assignment => ({ ...assignment,
                principalId: typeof assignment.principalId === 'string' ? assignment.principalId.toLowerCase() : assignment.principalId }));
            const directory = [];
            const cleanup = [];
            // Read the complete snapshot before any destructive action.
            for (const assignment of assignments) {
                try {
                    if (!GUID.test(assignment.principalId || '')) throw new Error('Invalid Graph principal ID');
                    if (assignment.principalType === 'Group') {
                        const info = await graphGet(`groups/${assignment.principalId}?$select=id,displayName,description`, token);
                        if (info.id?.toLowerCase() !== assignment.principalId.toLowerCase()) throw new Error('Graph group identity mismatch');
                        directory.push({ assignment, info, members: await getGroupMembers(token, assignment.principalId) });
                    } else if (assignment.principalType === 'User') {
                        const member = await graphGet(`users/${assignment.principalId}?$select=id,displayName,givenName,surname,mail,userPrincipalName`, token);
                        if (member.id?.toLowerCase() !== assignment.principalId.toLowerCase()) throw new Error('Graph user identity mismatch');
                        directory.push({ assignment, members: [member] });
                    }
                } catch (err) { errors.push(`Directory read failed for ${assignment.principalId}: ${err.message}`); }
            }
            const allGroups = await userStore.getAllGroups();
            const managed = allGroups.filter(g => g.source === 'azure' && g.organizationId === orgId && g.azureTenantId === tenantId);
            const assignedIds = new Set(assignments.filter(a => a.principalType === 'Group').map(a => a.principalId));
            for (const entry of directory) {
                let group = null;
                if (entry.info) {
                    const oid = entry.assignment.principalId;
                    group = await userStore.getGroupByAzureId(oid, tenantId, orgId);
                    if (!group) {
                        const legacy = allGroups.filter(g => g.source === 'azure' && g.organizationId === orgId && !g.azureTenantId && g.azureGroupId?.toLowerCase() === oid.toLowerCase());
                        if (legacy.length > 1) throw new Error(`Ambiguous legacy Azure group ${oid}; administrator review required`);
                        if (legacy.length === 1) {
                            // The concrete directory read above verifies provenance.
                            if (!await userStore.updateGroup(legacy[0].id, { azureTenantId: tenantId, azureGroupId: oid })) throw new Error(`Could not bind legacy Azure group ${oid}`);
                            group = { ...legacy[0], azureTenantId: tenantId, azureGroupId: oid };
                        }
                    }
                    if (!group) {
                        const id = `azure-${require('crypto').createHash('sha256').update(`${orgId}:${tenantId}:${oid}`).digest('hex').slice(0, 24)}`;
                        const created = await userStore.createGroup({ id, organizationId: orgId, azureTenantId: tenantId, azureGroupId: oid,
                            name: entry.info.displayName || oid, description: entry.info.description || '', source: 'azure', permissions: ['read', 'chat'], roles: [], lastSyncedAt: new Date().toISOString() });
                        if (!created) throw new Error(`Could not create Azure group ${oid}`);
                        group = await userStore.getGroupByAzureId(oid, tenantId, orgId);
                    } else if (!await userStore.updateGroup(group.id, { name: entry.info.displayName || group.name, description: entry.info.description || '', lastSyncedAt: new Date().toISOString() })) throw new Error(`Could not update Azure group ${oid}`);
                    syncedGroups++;
                }
                const memberIds = new Set(entry.members.map(m => typeof m.id === 'string' ? m.id.toLowerCase() : null));
                for (const rawMember of entry.members) {
                    const member = { ...rawMember, id: typeof rawMember.id === 'string' ? rawMember.id.toLowerCase() : null };
                    if (!GUID.test(member.id || '')) { errors.push('Directory returned an invalid user object ID'); continue; }
                    let user = await userStore.getUserByAzureId(member.id, tenantId);
                    const email = member.mail || member.userPrincipalName || '';
                    if (!user && (await findUnboundIdentity(member.id)).length) {
                        details.push(`Skipped ${member.id}: legacy Microsoft identity requires administrator confirmation`);
                        continue;
                    }
                    if (!user && email) {
                        const legacy = await userStore.getUserByEmail(email);
                        if (legacy) { details.push(`Skipped ${member.id}: Microsoft identity requires administrator confirmation`); continue; }
                    }
                    if (user && !isMemberOfOrg(user, [...allGroups, ...managed], orgId)) {
                        details.push(`Skipped ${member.id}: user is not an authorized member of the sync organization`);
                        continue;
                    }
                    if (!user) {
                        const id = `azure-${tenantId}-${member.id}`;
                        const result = await userStore.createUserWithSeatCheck({ id, username: email || id,
                            displayName: member.displayName || id, firstName: member.givenName || '', lastName: member.surname || '', email,
                            organizationId: orgId, azureTenantId: tenantId, azureUserId: member.id, role: 'user',
                            groups: [], orgRole: '', status: settings.autoActivateUsers ? 'active' : 'pending', passwordHash: '' }, { strict: false });
                        if (!result.created) { errors.push(`User ${member.id} was not provisioned (${result.reason})`); continue; }
                        if (group) await membershipStore.add(id, group, member.id);
                        syncedUsers++;
                    } else if (group) {
                        await membershipStore.add(user.id, group, member.id);
                    }
                }
                if (group) cleanup.push({ group, memberIds });
            }
            // No removal before all reads AND provisioning have succeeded.
            if (settings.destructiveSync && !errors.length) {
                for (const group of managed) if (!assignedIds.has(group.azureGroupId)) cleanup.push({ group, memberIds: new Set() });
                // Resolve every local read before removing anything. Preserve
                // local group IDs, shared resources and manual grants on upgrade.
                const users = await userStore.getAllUsers();
                for (const { group, memberIds } of cleanup) {
                    for (const user of users) {
                        if (user.azureTenantId !== tenantId || !isMemberOfOrg(user, allGroups, orgId)) continue;
                        if (!memberIds.has(user.azureUserId)) await membershipStore.remove(user.id, group, user.azureUserId);
                    }
                }
            }
        } catch (err) { errors.push(err.message); }
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
