'use strict';
/**
 * Microsoft-specific steps of the OAuth callback (providerCallbackRoutes.js):
 * linking an account from before tenant binding, the admin-link gate, and
 * which organisation a Microsoft login may be placed in.
 *
 * Placement never trusts the e-mail domain of a Microsoft profile (the `mail`
 * attribute is whatever the directory says, which on a shared server is the
 * cross-tenant bug). It trusts the VERIFIED tenant of the ID token instead:
 *   - the Azure sync binding names an organisation for exactly that tenant, or
 *   - the token comes from the configured concrete tenant and the server has
 *     exactly one organisation (the usual self-hosted installation).
 * Anything else leaves the account without an organisation for an admin to place.
 */
const log = require('../../telemetry/log');
const { GUID } = require('../microsoftIdentity');

const identityStore = () => require('../../stores/microsoftIdentityStore');
const lower = (v) => String(v || '').toLowerCase();

/**
 * Link an account from before tenant binding on its first login. Returns true
 * when a link was made (the caller then resolves the account again).
 * @param {{ azureUserId?: string|null, azureTenantId?: string|null, email?: string }} user
 * @param {string|undefined} configuredTenantId
 */
async function autoLinkOnLogin(user, configuredTenantId, store = identityStore()) {
    if (!user.azureUserId || !user.azureTenantId) return false;
    const linked = await store.autoLinkLegacy({
        azureTenantId: user.azureTenantId, azureUserId: user.azureUserId, email: user.email,
        configuredTenantId });
    if (linked.linked) log.info(`[OAuth/microsoft] Linked existing account ${linked.userId} to its Microsoft identity (${linked.basis})`);
    return !!linked.linked;
}

/**
 * An unlinked login that collides with an existing account (same e-mail, or
 * an unbound legacy object id) needs an administrator: record the request.
 * @returns {Promise<boolean>} true when the login must stop with sso_link_required
 */
async function requireAdminLink(user, userStore, store = identityStore()) {
    const collides = (user.email && await userStore.getUserByEmail(user.email))
        || (await store.findUnboundIdentity(user.azureUserId)).length;
    if (!collides) return false;
    await store.requestLink({ azureTenantId: user.azureTenantId, azureUserId: user.azureUserId, email: user.email });
    return true;
}

/**
 * The organisation a Microsoft login may be placed in, decided by its verified tenant.
 * @param {{ azureTenantId?: string|null }} user
 * @param {string|undefined} configuredTenantId
 * @param {{ getAllOrganizations: () => Promise<any[]> }} userStore
 * @param {() => Promise<any>} [getSyncBinding]
 */
async function trustedMicrosoftOrg(user, configuredTenantId, userStore,
    getSyncBinding = () => require('../../integrations/azureGroupSync').getSyncBinding()) {
    const tenant = lower(user.azureTenantId);
    if (!GUID.test(tenant)) return null;
    const orgs = await userStore.getAllOrganizations();
    let binding = null;
    try { binding = await getSyncBinding(); } catch (e) { log.warn(`[OAuth/microsoft] Azure sync binding unreadable: ${e.message}`); }
    if (binding?.syncOrganizationId && lower(binding.syncTenantId) === tenant) {
        return orgs.find((o) => o.id === binding.syncOrganizationId) || null;
    }
    if (lower(configuredTenantId) === tenant && orgs.length === 1) return orgs[0];
    return null;
}

/**
 * Store the signed-in user's Graph profile photo as an upload. Best-effort.
 * @returns {Promise<string|null>} the /uploads URL, or null without a photo
 */
async function saveMicrosoftPhoto(accessToken, user) {
    const fs = require('fs');
    const path = require('path');
    try {
        const photoResponse = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!photoResponse.ok) {
            log.info(`[OAuth/Microsoft] User has no photo or access denied: ${photoResponse.status}`);
            return null;
        }
        const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
        fs.mkdirSync(uploadDir, { recursive: true });
        const safeId = String(user.azureUserId || user.email || 'ms').replace(/[^a-zA-Z0-9]/g, '');
        const filename = `user-avatar-azure-${safeId}-${Date.now()}.jpg`;
        fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(await photoResponse.arrayBuffer()));
        return `/uploads/${filename}`;
    } catch (photoErr) {
        log.info(`[OAuth/Microsoft] Error fetching photo: ${photoErr.message}`);
        return null;
    }
}

module.exports = { autoLinkOnLogin, requireAdminLink, trustedMicrosoftOrg, saveMicrosoftPhoto };
