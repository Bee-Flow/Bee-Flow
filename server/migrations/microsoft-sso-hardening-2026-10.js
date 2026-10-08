'use strict';

const { GUID } = require('../auth/microsoftIdentity');
const { decryptValue } = require('../stores/configEncryption');
const { getClientCredentialsToken } = require('../integrations/azureGraph');

// The dry run opens only a read-only transaction. It does not import stores
// whose initialization creates tables, migrates rows or starts background work.
function createUpgradeInspector({ db, initialize, migrateSecrets, request = fetch, tokenFor = getClientCredentialsToken }) {
    return async function inspectUpgrade({ apply = false } = {}) {
        if (apply) await initialize();
        const snapshot = await db.withTransaction(async client => {
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
            const { rows: columns } = await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('config','users','groups','organizations')");
            const has = (table, column) => columns.some(c => c.table_name === table && c.column_name === column);
            const rows = async sql => (await client.query(sql)).rows;
            const config = has('config', 'key') ? await rows('SELECT key,value FROM config') : [];
            const users = has('users', 'azureUserId') ? await rows(`SELECT id,"azureUserId",${has('users', 'azureTenantId') ? '"azureTenantId"' : 'NULL::text AS "azureTenantId"'},"organizationId" FROM users WHERE "azureUserId" IS NOT NULL`) : [];
            const groups = has('groups', 'azureGroupId') ? await rows(`SELECT id,"azureGroupId",${has('groups', 'azureTenantId') ? '"azureTenantId"' : 'NULL::text AS "azureTenantId"'},"organizationId" FROM groups WHERE source='azure'`) : [];
            const organizations = has('organizations', 'id') ? await rows('SELECT id,name FROM organizations') : [];
            return { config, users, groups, organizations, schemaUpgradeRequired: !has('users', 'azureTenantId') || !has('groups', 'azureTenantId') };
        });
        const values = new Map(snapshot.config.map(row => [row.key, row.value]));
        const read = key => values.has(key) ? JSON.parse(values.get(key)) : null;
        const providers = read('providers') || {};
        const ms = providers.microsoft || {};
        const tenantId = GUID.test(ms.tenantId || '') ? ms.tenantId.toLowerCase() : null;
        let binding = read('azure_group_sync_binding');
        const report = { apply, tenantId, binding: binding || null, autoBinding: null, syncBindingAmbiguous: [], schemaUpgradeRequired: snapshot.schemaUpgradeRequired,
            organizations: snapshot.organizations, verified: [], unresolved: [], duplicateIdentities: [], groups: [],
            duplicateGroups: [], periodicSyncsDisabled: [], plaintextSecretProviders: [] };
        for (const [name, entry] of [...Object.entries(providers), ['nextcloud', read('oauth')]]) {
            if (entry?.clientSecret) report.plaintextSecretProviders.push(name);
        }
        for (const [key] of values) {
            if (!key.startsWith('azure_group_sync_') || key.startsWith('azure_group_sync_status_') || key === 'azure_group_sync_binding') continue;
            const orgId = key.slice('azure_group_sync_'.length);
            if (read(key)?.periodicSync && (!GUID.test(binding?.syncTenantId || '') || orgId !== binding?.syncOrganizationId)) report.periodicSyncsDisabled.push(orgId);
        }
        const seen = new Map();
        for (const user of snapshot.users) {
            const oid = user.azureUserId.toLowerCase();
            const owners = seen.get(oid) || [];
            owners.push(user.id); seen.set(oid, owners);
        }
        for (const [objectId, owners] of seen) if (owners.length > 1) report.duplicateIdentities.push({ objectId, users: owners });
        const grouped = new Map();
        for (const group of snapshot.groups) {
            const key = `${group.organizationId}:${group.azureGroupId?.toLowerCase()}`;
            grouped.set(key, [...(grouped.get(key) || []), group.id]);
        }
        for (const [identity, ids] of grouped) if (ids.length > 1) report.duplicateGroups.push({ identity, groups: ids });
        let token;
        if (tenantId && ms.clientId) {
            const rawSecret = values.get('oauth_microsoft_client_secret');
            const secret = rawSecret ? decryptValue(rawSecret) : ms.clientSecret;
            if (rawSecret && !secret && apply) throw new Error('Microsoft OAuth credential cannot be decrypted');
            if (secret) {
                try { token = await tokenFor(ms.clientId, secret, tenantId); }
                catch { /* Directory unavailable: leave identities unbound. */ }
            }
        }
        const verifyDirectoryObject = async (kind, oid) => {
            const response = await request(`https://graph.microsoft.com/v1.0/${kind}/${oid}?$select=id`, {
                headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
            });
            const data = response.ok ? await response.json() : null;
            return data?.id?.toLowerCase() === oid.toLowerCase();
        };
        // 'yes' | 'no' (the directory answered that the object does not exist) |
        // 'unknown' (no credentials, missing Graph permission, network error).
        const checkUser = async oid => {
            if (!token) return 'unknown';
            try {
                const response = await request(`https://graph.microsoft.com/v1.0/users/${oid}?$select=id`, {
                    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
                });
                if (response.status === 404) return 'no';
                if (!response.ok) return 'unknown';
                return (await response.json())?.id?.toLowerCase() === oid.toLowerCase() ? 'yes' : 'no';
            } catch { return 'unknown'; }
        };
        for (const user of snapshot.users.filter(u => !u.azureTenantId)) {
            if (!tenantId || !GUID.test(user.azureUserId) || seen.get(user.azureUserId.toLowerCase()).length !== 1) {
                report.unresolved.push({ userId: user.id, reason: 'administrator_confirmation_required' }); continue;
            }
            // The stored object ID was written by an earlier login or sync against
            // the one configured concrete directory, so that directory is its
            // tenant. A directory that positively denies the object blocks the
            // automatic link; an unreachable directory does not.
            const state = await checkUser(user.azureUserId);
            if (state === 'no') { report.unresolved.push({ userId: user.id, reason: 'directory_identity_not_verified' }); continue; }
            report.verified.push({ userId: user.id, tenantId, objectId: user.azureUserId.toLowerCase(),
                basis: state === 'yes' ? 'directory_verified' : 'configured_tenant' });
        }
        // Exactly one organisation with Azure sync configured: bind it to the
        // configured concrete tenant, so periodic sync keeps running. Anything
        // else stays unbound until a platform administrator decides.
        if (!binding?.syncOrganizationId || !GUID.test(binding.syncTenantId || '')) {
            const known = new Set(snapshot.organizations.map(o => o.id));
            const candidates = new Set();
            for (const [key] of values) {
                if (!key.startsWith('azure_group_sync_') || key.startsWith('azure_group_sync_status_') || key === 'azure_group_sync_binding') continue;
                const orgId = key.slice('azure_group_sync_'.length);
                if (known.has(orgId)) candidates.add(orgId);
            }
            for (const group of snapshot.groups) if (group.organizationId && known.has(group.organizationId)) candidates.add(group.organizationId);
            if (candidates.size === 1 && tenantId) {
                report.autoBinding = { syncOrganizationId: [...candidates][0], syncTenantId: tenantId, configuredBy: 'migration', configuredAt: new Date().toISOString() };
                binding = report.autoBinding;
            } else if (candidates.size > 1) report.syncBindingAmbiguous = [...candidates];
            report.binding = binding || null;
        }
        report.periodicSyncsDisabled = report.periodicSyncsDisabled.filter(orgId => !(GUID.test(binding?.syncTenantId || '') && orgId === binding?.syncOrganizationId));
        if (binding?.syncOrganizationId && GUID.test(binding.syncTenantId || '') && token && tenantId === binding.syncTenantId) {
            for (const group of snapshot.groups) {
                if (group.azureTenantId || group.organizationId !== binding.syncOrganizationId || !GUID.test(group.azureGroupId || '') || grouped.get(`${group.organizationId}:${group.azureGroupId.toLowerCase()}`).length !== 1) continue;
                try {
                    if (await verifyDirectoryObject('groups', group.azureGroupId)) report.groups.push({ groupId: group.id, tenantId: binding.syncTenantId,
                        objectId: group.azureGroupId.toLowerCase(), organizationId: group.organizationId });
                } catch { /* Preserve groups whose provenance cannot be verified. */ }
            }
        }
        if (apply) {
            await migrateSecrets();
            await db.withTransaction(async client => {
                await client.query("SELECT pg_advisory_xact_lock(hashtext('beeflow:microsoft-bindings'))");
                if (report.autoBinding) await client.query('INSERT INTO config(key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO NOTHING',
                    ['azure_group_sync_binding', JSON.stringify(report.autoBinding)]);
                for (const user of report.verified) {
                    const { rowCount } = await client.query('UPDATE users SET "azureTenantId"=$1,"azureUserId"=$2 WHERE id=$3 AND "azureTenantId" IS NULL AND LOWER("azureUserId")=$2 RETURNING id', [user.tenantId, user.objectId, user.userId]);
                    if (rowCount) await client.query('INSERT INTO microsoft_sso_binding_audit (actor_id,user_id,tenant_id,object_id,action) VALUES ($1,$2,$3,$4,$5)', ['migration', user.userId, user.tenantId, user.objectId, 'migrate']);
                }
                for (const group of report.groups) await client.query('UPDATE groups SET "azureTenantId"=$1,"azureGroupId"=$3 WHERE id=$2 AND "azureTenantId" IS NULL AND LOWER("azureGroupId")=$3 AND "organizationId"=$4',
                    [group.tenantId, group.groupId, group.objectId, group.organizationId]);
            });
        }
        return report;
    };
}
function inspectUpgrade(options) {
    return createUpgradeInspector({ db: require('../db'),
        initialize: async () => { await require('../stores/userStore').initDB(); await require('../stores/configStore').initDB(); },
        migrateSecrets: () => require('../stores/authConfigStore').migrate(),
    })(options);
}
async function up() {
    const report = await inspectUpgrade({ apply: true });
    console.log(`[MicrosoftSSOUpgrade] ${report.verified.length} identities linked; ${report.unresolved.length} require administrator confirmation; ${report.periodicSyncsDisabled.length} periodic sync configurations have no authorized binding`);
    if (report.autoBinding) console.log('[MicrosoftSSOUpgrade] Azure sync bound automatically to the single configured organization and the SSO tenant');
    if (report.syncBindingAmbiguous.length) console.warn(`[MicrosoftSSOUpgrade] ${report.syncBindingAmbiguous.length} organizations have Azure sync data; a platform administrator must choose one in Security > SSO`);
}
module.exports = { up, inspectUpgrade, createUpgradeInspector };
