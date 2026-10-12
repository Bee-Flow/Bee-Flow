// @typecheck
/**
 * SSO User Resolver
 *
 * Shared matching logic used by the OAuth callback to find an existing local
 * user for an SSO login before falling back to creating a new one.
 *
 * Microsoft identities match only the validated tenant/object-ID pair.
 * Email and local-ID resolution remain available for other providers.
 */

const crypto = require('crypto');
const { isFreeEmailDomain } = require('../utils/freeEmailDomains');

const AZURE_OID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check whether a string looks like an Azure AD object id (GUID).
 * Used by the cleanup tool to identify duplicate users whose local id is a
 * raw OID — a telltale sign they were auto-created by the buggy OAuth path.
 */
function isAzureOid(value) {
    return typeof value === 'string' && AZURE_OID_REGEX.test(value);
}

/**
 * Derive a stable, human-readable local user id for a new SSO user.
 * Mirrors the slug used by azureGroupSync so a later directory sync does not
 * create a second duplicate for the same person.
 */
function deriveLocalUserId(email, azureUserId) {
    if (email && email.includes('@')) {
        const slug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '');
        if (slug) return slug;
    }
    if (azureUserId) return `azure-${String(azureUserId).substring(0, 8)}`;
    return `sso-${Date.now().toString(36)}`;
}

/**
 * Resolve the canonical local user for an incoming SSO identity.
 *
 * @param {object} identity
 *   - azureUserId: the Azure AD object id (oid) — null for non-Microsoft providers
 *   - email: from the SSO provider (mail or userPrincipalName for Microsoft)
 *   - localId: the provisional local id used by the caller (only used as a
 *              last-resort lookup for non-Azure providers)
 * @param {object} userStore  store with getUserByAzureId, getUserByEmail, getUser, updateUser
 * @returns {Promise<{user: object|null, branch: 'azureId'|'email'|'legacyId'|'none'}>}
 *
 */
async function resolveExistingSSOUser(identity, userStore) {
    const { azureUserId, azureTenantId, email, localId } = identity;

    if (azureUserId) {
        const byAzure = azureTenantId ? await userStore.getUserByAzureId(azureUserId, azureTenantId) : null;
        return { user: byAzure, branch: byAzure ? 'azureId' : 'none' };
    }

    if (email) {
        const byEmail = await userStore.getUserByEmail(email);
        if (byEmail) {
            return { user: byEmail, branch: 'email' };
        }
    }

    // Non-Azure providers (e.g. Nextcloud) historically used the provider id
    // directly as the local id. Keep that lookup for backward compatibility,
    // but never for Microsoft — its OIDs would re-introduce the duplicate bug.
    if (!azureUserId && localId) {
        const byId = await userStore.getUser(localId);
        if (byId) return { user: byId, branch: 'legacyId' };
    }

    return { user: null, branch: 'none' };
}

/**
 * Find an organization whose allowedDomains (or contact-email domain) matches
 * the email address. Returns null if nothing matches.
 *
 * SECURITY: a free/public email provider (gmail.com, outlook.com, …) NEVER
 * matches — nobody "owns" gmail.com, so a shared provider domain must not bind
 * a stranger into someone else's org. This guard sits ahead of BOTH branches so
 * even a mis-configured allowedDomains entry or a dirty legacy row cannot leak.
 * (This omission was the root cause of the free-mail org-binding incident.)
 *
 * @param {string} email
 * @param {Array<object>} orgs
 * @param {Set<string>} [freeDomains]  effective free-provider blocklist from
 *   getEffectiveFreeEmailDomains() (built-in floor ∪ admin extras). Omit to use
 *   the built-in floor only.
 */
function resolveOrgByEmailDomain(email, orgs, freeDomains) {
    if (!email || !email.includes('@')) return null;
    const userDomain = email.split('@')[1].toLowerCase();
    if (isFreeEmailDomain(userDomain, freeDomains)) return null;
    return orgs.find(org => {
        if (Array.isArray(org.allowedDomains) && org.allowedDomains.length > 0) {
            return org.allowedDomains.includes(userDomain);
        }
        if (!org.email || !org.email.includes('@')) return false;
        return org.email.split('@')[1].toLowerCase() === userDomain;
    }) || null;
}

/**
 * Decide the org placement fields for a brand-new SSO user, honouring the
 * matched org's auto-approve setting. Pure — returns the fields to persist.
 *
 * - no org matched         → org-less active account (consumer / "no org" screen)
 * - org.autoApproveSSO true → active member, org default groups applied
 * - org.autoApproveSSO false → pending member (awaits admin approval), no groups
 *
 * This is what closes the approval-bypass: previously the create path stamped
 * the org with the default 'active' status directly, so the auto-approve/pending
 * decision (which lived in a later block guarded by !userHasOrg) never ran.
 *
 * `existingGroups` is for the second caller — binding a pre-existing org-less
 * account found by domain match, which must keep the groups it already had. The
 * create path passes nothing, so its result is unchanged.
 */
function planNewSSOUserPlacement(org, { existingGroups = [] } = {}) {
    const keep = Array.isArray(existingGroups) ? existingGroups : [];
    if (!org || !org.id) {
        return { organizationId: '', orgRole: '', status: 'active', groups: [...keep] };
    }
    if (org.autoApproveSSO === true) {
        const defaults = Array.isArray(org.defaultGroups) ? org.defaultGroups : [];
        return {
            organizationId: org.id,
            orgRole: 'user',
            status: 'active',
            groups: [...new Set([...keep, ...defaults])],
        };
    }
    return { organizationId: org.id, orgRole: '', status: 'pending', groups: [...keep] };
}

/**
 * Derive a stable local user id for a NEW SSO account that is guaranteed not to
 * collide with an existing, unrelated user.
 *
 * The base slug (email local-part) is guessable, so keying a new account on it
 * bare lets an attacker registering `<victim-local-part>@gmail.com` land on the
 * victim's row (the failed create was previously swallowed and the session was
 * built around whatever row already held the id — an account-takeover path). On
 * collision we append a short, deterministic suffix derived from the provider's
 * stable subject id + email, so repeated callbacks for the SAME identity resolve
 * to the same id (idempotent) while a DIFFERENT identity never reuses the slug.
 *
 * @param {string} email
 * @param {string} providerKey  provider-stable id (Google `sub` / Azure oid)
 * @param {(id:string)=>Promise<boolean>} isTaken  true if a row with `id` exists
 * @returns {Promise<string>}
 */
async function deriveAvailableLocalUserId(email, providerKey, isTaken) {
    const base = deriveLocalUserId(email, providerKey);
    if (!(await isTaken(base))) return base;

    const suffix = crypto
        .createHash('sha256')
        .update(`${providerKey || ''}|${String(email || '').toLowerCase()}`)
        .digest('hex')
        .slice(0, 6);
    const candidate = `${base}-${suffix}`;
    if (!(await isTaken(candidate))) return candidate;

    // Extremely unlikely (base AND deterministic suffix both taken). Fall back
    // to a time-based suffix; the caller still verifies the create result, so a
    // residual race fails the login loudly rather than binding to a stranger.
    for (let i = 0; i < 5; i++) {
        const alt = `${base}-${Date.now().toString(36)}${i || ''}`;
        if (!(await isTaken(alt))) return alt;
    }
    return candidate;
}

module.exports = {
    isAzureOid,
    deriveLocalUserId,
    deriveAvailableLocalUserId,
    resolveExistingSSOUser,
    resolveOrgByEmailDomain,
    planNewSSOUserPlacement,
    AZURE_OID_REGEX,
};
