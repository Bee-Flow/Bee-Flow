'use strict';

const { GUID } = require('../auth/microsoftIdentity');
const { conflict, notFound, forbidden } = require('../shared/httpErrors');

function createMicrosoftIdentityStore({ run, getAll, withTransaction }, initialize = async () => {}) {
async function authorizeActor(client, actorId) {
    const { rows } = await client.query('SELECT role,status FROM users WHERE id=$1 FOR SHARE', [actorId]);
    if (rows[0]?.role !== 'admin' || rows[0].status === 'suspended') throw forbidden('platform_admin_required', 'Only an active platform administrator may change Microsoft identities.');
}
async function requestLink({ azureTenantId, azureUserId, email = '' }) {
    await initialize();
    if (!GUID.test(azureTenantId || '') || !GUID.test(azureUserId || '')) throw new Error('Microsoft identity must be validated');
    azureTenantId = azureTenantId.toLowerCase(); azureUserId = azureUserId.toLowerCase();
    const { rows } = await run(`INSERT INTO microsoft_sso_link_requests (tenant_id, object_id, email, expires_at)
        VALUES ($1,$2,$3,NOW()+INTERVAL '7 days') ON CONFLICT (tenant_id, object_id)
        DO UPDATE SET email=EXCLUDED.email, expires_at=EXCLUDED.expires_at RETURNING id`,
    [azureTenantId, azureUserId, String(email).slice(0, 320)]);
    return rows[0].id;
}
async function listRequests() {
    await initialize();
    return getAll('SELECT id, tenant_id, object_id, email, expires_at FROM microsoft_sso_link_requests WHERE expires_at>NOW() ORDER BY expires_at DESC LIMIT 100');
}
async function bind(userId, requestId, actorId) {
    await initialize();
    return withTransaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('beeflow:microsoft-bindings'))");
        await authorizeActor(client, actorId);
        const { rows: requests } = await client.query('SELECT * FROM microsoft_sso_link_requests WHERE id=$1 AND expires_at>NOW() FOR UPDATE', [requestId]);
        const request = requests[0];
        if (!request) throw notFound('sso_request_expired', 'The Microsoft identity request has expired. Sign in again first.');
        const { rows: users } = await client.query('SELECT id, "azureTenantId", "azureUserId" FROM users WHERE id=$1 FOR UPDATE', [userId]);
        if (!users[0]) throw notFound('user_not_found');
        if (users[0].azureTenantId) throw conflict('sso_identity_already_bound', 'Disconnect the existing Microsoft identity first.');
        const { rows: owners } = await client.query('SELECT id FROM users WHERE "azureTenantId"=$1 AND "azureUserId"=$2', [request.tenant_id, request.object_id]);
        if (owners.length) throw conflict('sso_identity_in_use', 'This Microsoft identity is already linked to another account.');
        if (!GUID.test(request.tenant_id) || !GUID.test(request.object_id)) throw new Error('Invalid stored Microsoft identity');
        await client.query('UPDATE users SET "azureTenantId"=$1, "azureUserId"=$2 WHERE id=$3', [request.tenant_id, request.object_id, userId]);
        await client.query('INSERT INTO microsoft_sso_binding_audit (actor_id, user_id, tenant_id, object_id, action) VALUES ($1,$2,$3,$4,$5)', [actorId, userId, request.tenant_id, request.object_id, 'bind']);
        await client.query('DELETE FROM microsoft_sso_link_requests WHERE id=$1', [requestId]);
    }).catch(err => {
        if (err.code === '23505') throw conflict('sso_identity_in_use', 'This Microsoft identity is already linked to another account.');
        throw err;
    });
}
async function unbind(userId, actorId) {
    await initialize();
    return withTransaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('beeflow:microsoft-bindings'))");
        await authorizeActor(client, actorId);
        const { rows } = await client.query('SELECT "azureTenantId", "azureUserId" FROM users WHERE id=$1 FOR UPDATE', [userId]);
        if (!rows[0]) throw notFound('user_not_found');
        await client.query('UPDATE users SET "azureTenantId"=NULL, "azureUserId"=NULL WHERE id=$1', [userId]);
        await client.query('INSERT INTO microsoft_sso_binding_audit (actor_id, user_id, tenant_id, object_id, action) VALUES ($1,$2,$3,$4,$5)', [actorId, userId, rows[0].azureTenantId, rows[0].azureUserId, 'unbind']);
    });
}
async function findUnboundIdentity(objectId) {
    await initialize();
    return getAll('SELECT id FROM users WHERE "azureTenantId" IS NULL AND LOWER("azureUserId")=$1', [objectId.toLowerCase()]);
}
// First login after the upgrade. Installations that predate tenant binding hold
// an object ID (written by an earlier Microsoft login or directory sync) or only
// an e-mail address. Link them without an administrator ONLY when the verified ID
// token comes from the configured CONCRETE tenant (never common/organizations/
// consumers) and the match is unambiguous. Anything else returns a reason and the
// caller falls back to the administrator approval request.
async function autoLinkLegacy({ azureTenantId, azureUserId, email = '', configuredTenantId }) {
    await initialize();
    if (!GUID.test(azureTenantId || '') || !GUID.test(azureUserId || '')) return { linked: false, reason: 'invalid_identity' };
    if (!GUID.test(configuredTenantId || '') || configuredTenantId.toLowerCase() !== azureTenantId.toLowerCase()) return { linked: false, reason: 'tenant_not_concrete' };
    const tenant = azureTenantId.toLowerCase(), oid = azureUserId.toLowerCase();
    return withTransaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('beeflow:microsoft-bindings'))");
        const { rows: owners } = await client.query('SELECT id FROM users WHERE LOWER("azureTenantId")=$1 AND LOWER("azureUserId")=$2', [tenant, oid]);
        if (owners.length) return { linked: false, reason: 'already_bound' };
        const { rows: byOid } = await client.query('SELECT id,"azureTenantId" FROM users WHERE LOWER("azureUserId")=$1 FOR UPDATE', [oid]);
        let target = null, basis;
        if (byOid.length > 1) return { linked: false, reason: 'duplicate_object_id' };
        if (byOid.length === 1) {
            if (byOid[0].azureTenantId) return { linked: false, reason: 'bound_to_other_tenant' };
            target = byOid[0]; basis = 'auto-link-oid';
        } else if (email) {
            // Old behaviour: a Microsoft login attached to the one local account with this
            // e-mail address. Platform administrators are never attached this way.
            const { rows: byEmail } = await client.query(`SELECT id,role,"azureTenantId","azureUserId" FROM users WHERE LOWER(email)=LOWER($1) FOR UPDATE`, [email]);
            if (byEmail.length !== 1) return { linked: false, reason: byEmail.length ? 'duplicate_email' : 'no_match' };
            if (byEmail[0].azureTenantId || byEmail[0].azureUserId) return { linked: false, reason: 'bound_to_other_identity' };
            if (byEmail[0].role === 'admin') return { linked: false, reason: 'platform_admin_requires_approval' };
            target = byEmail[0]; basis = 'auto-link-email';
        } else return { linked: false, reason: 'no_match' };
        await client.query('UPDATE users SET "azureTenantId"=$1, "azureUserId"=$2 WHERE id=$3', [tenant, oid, target.id]);
        await client.query('INSERT INTO microsoft_sso_binding_audit (actor_id, user_id, tenant_id, object_id, action) VALUES ($1,$2,$3,$4,$5)', [basis, target.id, tenant, oid, 'migrate']);
        await client.query('DELETE FROM microsoft_sso_link_requests WHERE tenant_id=$1 AND object_id=$2', [tenant, oid]);
        return { linked: true, userId: target.id, basis };
    }).catch(err => {
        if (err.code === '23505') return { linked: false, reason: 'conflict' };
        throw err;
    });
}
async function getIdentityBinding(userId) {
    await initialize();
    const rows = await getAll(`SELECT LOWER(u."azureTenantId") AS "azureTenantId", LOWER(u."azureUserId") AS "azureUserId",
        COALESCE((SELECT MAX(a.id)::text FROM microsoft_sso_binding_audit a WHERE a.user_id=u.id), '0') AS revision
        FROM users u WHERE u.id=$1`, [userId]);
    return rows[0] || null;
}
return { requestLink, listRequests, bind, unbind, findUnboundIdentity, autoLinkLegacy, getIdentityBinding };
}
let instance;
const current = () => instance ||= createMicrosoftIdentityStore(require('../db'), () => require('./userStore').initDB());
module.exports = { createMicrosoftIdentityStore,
    requestLink: (...args) => current().requestLink(...args),
    listRequests: (...args) => current().listRequests(...args),
    bind: (...args) => current().bind(...args),
    unbind: (...args) => current().unbind(...args),
    findUnboundIdentity: (...args) => current().findUnboundIdentity(...args),
    autoLinkLegacy: (...args) => current().autoLinkLegacy(...args),
    getIdentityBinding: (...args) => current().getIdentityBinding(...args),
};
