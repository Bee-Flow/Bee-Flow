'use strict';
const { parseGroupIds, isMemberOfOrg } = require('../auth/orgMembership');

function createAzureSyncMembershipStore(db) {
    async function change(userId, group, add, azureUserId) {
        return db.withTransaction(async client => {
            const { rows } = await client.query('SELECT groups,"organizationId","azureTenantId","azureUserId" FROM users WHERE id=$1 FOR UPDATE', [userId]);
            if (!rows[0]) return;
            const ids = parseGroupIds(rows[0]);
            const { rows: groups } = await client.query('SELECT id,"organizationId","azureTenantId",source FROM groups WHERE id=ANY($1) FOR SHARE', [[...ids, group.id]]);
            const target = groups.find(row => row.id === group.id);
            const authorized = target?.source === 'azure' && target.organizationId === group.organizationId
                && target.azureTenantId === group.azureTenantId && rows[0].azureTenantId === group.azureTenantId
                && typeof azureUserId === 'string' && rows[0].azureUserId?.toLowerCase() === azureUserId.toLowerCase()
                && isMemberOfOrg(rows[0], groups, group.organizationId);
            if (!authorized) {
                if (add) throw new Error('Azure membership authorization changed; retry after administrator review');
                return;
            }
            if (add) {
                // A pre-existing manual grant never becomes sync-owned.
                if (ids.includes(group.id)) return;
                await client.query('UPDATE users SET groups=$1 WHERE id=$2', [JSON.stringify([...ids, group.id]), userId]);
                await client.query(`INSERT INTO azure_sync_memberships (user_id,group_id,organization_id,tenant_id)
                    VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,group_id) DO NOTHING`, [userId, group.id, group.organizationId, group.azureTenantId]);
            } else {
                const { rowCount } = await client.query('DELETE FROM azure_sync_memberships WHERE user_id=$1 AND group_id=$2 AND organization_id=$3 AND tenant_id=$4 RETURNING user_id', [userId, group.id, group.organizationId, group.azureTenantId]);
                if (!rowCount) return;
                await client.query('UPDATE users SET groups=$1 WHERE id=$2', [JSON.stringify(ids.filter(id => id !== group.id)), userId]);
            }
            return true;
        });
    }
    return { add: (userId, group, azureUserId) => change(userId, group, true, azureUserId), remove: (userId, group, azureUserId) => change(userId, group, false, azureUserId) };
}
let store;
const current = () => store ||= createAzureSyncMembershipStore(require('../db'));
async function updateMembership(method, userId, group, azureUserId) {
    const changed = await current()[method](userId, group, azureUserId);
    if (changed) await require('../auth/permissions').invalidatePermissionCache(userId);
    return changed;
}
module.exports = { createAzureSyncMembershipStore, add: (userId, group, azureUserId) => updateMembership('add', userId, group, azureUserId), remove: (userId, group, azureUserId) => updateMembership('remove', userId, group, azureUserId) };
