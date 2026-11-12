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
 * Whether an SSO identity may sign in to an existing row found by e-mail
 * alone (the caller also requires an e-mail the provider verified, or a
 * connector row of the same Nextcloud instance). The row must carry no
 * credential or second factor of its own, must not be a platform admin, must
 * not belong to a Microsoft identity, and a connector-provisioned row must
 * name the same Nextcloud uid. An account that does not qualify is linked by
 * its owner from account settings instead.
 * @param {Record<string, any>} row
 * @param {{ provider?: string | null, localId?: string | null, subject?: string | null }} identity
 */
function emailLinkAllowed(row, identity) {
    if (!noOwnCredential(row)) return false;
    if (row.provider === 'nextcloud_connector') {
        const uid = identity.subject || String(identity.localId || '').replace(/^nextcloud-/, '');
        return identity.provider === 'nextcloud' && !!uid && row.nc_uid === uid;
    }
    return true;
}

/**
 * No password, OPAQUE record, second factor, admin role or Microsoft binding.
 * @param {Record<string, any>} row
 */
function noOwnCredential(row) {
    if (row.role === 'admin') return false;
    if (row.passwordHash || row.opaqueRecord || row.mfa_enabled || row.mfaEnabled) return false;
    return !row.azureUserId;
}

/** @param {unknown} url */
function originOf(url) {
    try { return new URL(String(url)).origin.toLowerCase(); } catch { return ''; }
}

/**
 * A connector-provisioned row of the Nextcloud instance this sign-in came
 * from, with the same uid: an identity match, not an e-mail match.
 * @param {Record<string, any>} row
 * @param {SsoIdentity} identity
 * @param {Pick<typeof import('../stores/userStore'), 'getOrganization'>} userStore
 */
async function sameConnectorInstance(row, identity, userStore) {
    if (identity.provider !== 'nextcloud' || row.provider !== 'nextcloud_connector') return false;
    if (!identity.subject || row.nc_uid !== identity.subject || !identity.ncBaseUrl || !row.organizationId) return false;
    const org = await userStore.getOrganization(row.organizationId);
    const base = originOf(org?.nc_base_url || org?.ncBaseUrl);
    return !!base && base === originOf(identity.ncBaseUrl);
}

/**
 * @typedef {{ azureUserId?: string | null, azureTenantId?: string | null, email?: string | null, localId?: string | null,
 *   provider?: string | null, subject?: string | null, emailVerified?: boolean, ncBaseUrl?: string | null,
 *   legacyRawUid?: string | null }} SsoIdentity
 * @typedef {Pick<import('./ssoIdentityStore.mts').SsoIdentityStore, 'findUserId' | 'hasOtherSubject' | 'listForUser'>} IdentityLookup
 * @typedef {'azureId'|'subject'|'email'|'legacyId'|'legacyRawUid'|'emailRefused'|'none'} ResolveBranch
 */

/**
 * Resolve the canonical local user for an incoming SSO identity.
 *
 * `identity`: `azureUserId` is the Azure AD object id (oid) — null for
 * non-Microsoft providers; `email` comes from the SSO provider (mail or
 * userPrincipalName for Microsoft); `subject` is the provider's stable id
 * (Google `sub`, the Nextcloud uid); `localId` is the provider-derived local
 * id older accounts were created under (Google `sub`, `nextcloud-<uid>`);
 * `emailVerified` is true only when the provider asserted the address;
 * `legacyRawUid` is set by the legacy Nextcloud callback only.
 *
 * Order for non-Microsoft providers:
 *   1. (provider, subject) in sso_identities;
 *   2. the provider-derived id, on a row with no credential of its own that
 *      carries no other subject of this provider;
 *   3. the raw Nextcloud uid (legacy callback): the same, plus the same
 *      e-mail and no SSO identity recorded at all;
 *   4. the e-mail, when verified (or a connector row of the same instance)
 *      and emailLinkAllowed passes, on a row with no other subject of this
 *      provider.
 * A row found by e-mail that may not be linked answers 'emailRefused', so the
 * caller refuses the sign-in instead of creating a second account.
 *
 * @param {SsoIdentity} identity
 * @param {ResolverUserStore} userStore
 * @param {IdentityLookup | null} [identities] the sso_identities store; without it steps 1 and the subject checks are skipped
 * @returns {Promise<{user: any|null, branch: ResolveBranch}>}
 */
async function resolveExistingSSOUser(identity, userStore, identities = null) {
    const { azureUserId, azureTenantId } = identity;
    if (azureUserId) {
        const byAzure = azureTenantId ? await userStore.getUserByAzureId(azureUserId, azureTenantId) : null;
        return { user: byAzure, branch: byAzure ? 'azureId' : 'none' };
    }
    return (await bySubject(identity, userStore, identities))
        || (await byLegacyId(identity, userStore, identities))
        || (await byLegacyRawUid(identity, userStore, identities))
        || (await byEmail(identity, userStore, identities))
        || { user: null, branch: 'none' };
}

/** @typedef {Pick<typeof import('../stores/userStore'), 'getUserByAzureId' | 'getUserByEmail' | 'getUser'> & Partial<Pick<typeof import('../stores/userStore'), 'getOrganization'>>} ResolverUserStore */
/** @typedef {Promise<{ user: any|null, branch: ResolveBranch } | null>} StepResult */

/**
 * Step 1: (provider, subject) in sso_identities.
 * @param {SsoIdentity} identity @param {ResolverUserStore} userStore @param {IdentityLookup | null} identities
 * @returns {StepResult}
 */
async function bySubject({ provider, subject }, userStore, identities) {
    if (!identities || !provider || !subject) return null;
    const ownerId = await identities.findUserId(provider, subject);
    const owner = ownerId ? await userStore.getUser(ownerId) : null;
    return owner ? { user: owner, branch: 'subject' } : null;
}

/**
 * True when the account already carries another subject of this provider.
 * @param {Record<string, any>} row @param {SsoIdentity} identity @param {IdentityLookup | null} identities
 */
async function boundElsewhere(row, { provider, subject }, identities) {
    return !!(identities && provider && await identities.hasOtherSubject(row.id, provider, subject));
}

/**
 * Step 2: the provider-derived id older accounts were created under (never
 * for Microsoft — its OIDs would re-introduce the duplicate bug). An id that
 * is the e-mail itself is not provider-bound.
 * @param {SsoIdentity} identity @param {ResolverUserStore} userStore @param {IdentityLookup | null} identities
 * @returns {StepResult}
 */
async function byLegacyId(identity, userStore, identities) {
    const { localId, email } = identity;
    if (!localId || localId === email) return null;
    const byId = await userStore.getUser(localId);
    if (!byId || !noOwnCredential(byId) || await boundElsewhere(byId, identity, identities)) return null;
    return { user: byId, branch: 'legacyId' };
}

/**
 * Step 3 (legacy Nextcloud callback): an account under the raw uid, with the
 * same e-mail and no SSO identity recorded at all.
 * @param {SsoIdentity} identity @param {ResolverUserStore} userStore @param {IdentityLookup | null} identities
 * @returns {StepResult}
 */
async function byLegacyRawUid({ legacyRawUid, email }, userStore, identities) {
    if (!legacyRawUid || !email || !identities) return null;
    const row = await userStore.getUser(legacyRawUid);
    if (!row || String(row.email || '').toLowerCase() !== String(email).toLowerCase() || !noOwnCredential(row)) return null;
    return (await identities.listForUser(row.id)).length === 0 ? { user: row, branch: 'legacyRawUid' } : null;
}

/**
 * Step 4: the e-mail, when the provider verified it (or the row is a
 * connector row of the same instance) and emailLinkAllowed passes.
 * @param {SsoIdentity} identity @param {ResolverUserStore} userStore @param {IdentityLookup | null} identities
 * @returns {StepResult}
 */
async function byEmail(identity, userStore, identities) {
    if (!identity.email) return null;
    const row = await userStore.getUserByEmail(identity.email);
    if (!row) return null;
    const trusted = identity.emailVerified === true
        || (!!userStore.getOrganization && await sameConnectorInstance(row, identity, /** @type {Pick<typeof import('../stores/userStore'), 'getOrganization'>} */ (userStore)));
    if (trusted && emailLinkAllowed(row, identity) && !(await boundElsewhere(row, identity, identities))) return { user: row, branch: 'email' };
    return { user: null, branch: 'emailRefused' };
}

/**
 * Find THE organization whose allowedDomains (or confirmed contact-email
 * domain) matches the email address. Returns null if nothing matches, and
 * also when more than one organisation does: a domain two organisations
 * claim places nobody.
 *
 * SECURITY: a free/public email provider (gmail.com, outlook.com, …) NEVER
 * matches — nobody "owns" gmail.com, so a shared provider domain must not bind
 * a stranger into someone else's org. This guard sits ahead of BOTH branches so
 * even a mis-configured allowedDomains entry or a dirty legacy row cannot leak.
 * (This omission was the root cause of the free-mail org-binding incident.)
 *
 * The contact e-mail counts only for an organisation in `confirmedContactOrgIds`
 * (auth/orgDomainMatch.mts decides which: an administrator with a verified
 * address on the domain, or a platform admin who set it). Without the set the
 * contact e-mail never matches.
 *
 * @param {string} email
 * @param {Array<any>} orgs
 * @param {Set<string>} [freeDomains]  effective free-provider blocklist from
 *   getEffectiveFreeEmailDomains() (built-in floor ∪ admin extras). Omit to use
 *   the built-in floor only.
 * @param {ReadonlySet<string>} [confirmedContactOrgIds]
 */
function resolveOrgByEmailDomain(email, orgs, freeDomains, confirmedContactOrgIds = new Set()) {
    if (!email || !email.includes('@')) return null;
    const userDomain = email.split('@')[1].toLowerCase();
    if (isFreeEmailDomain(userDomain, freeDomains)) return null;
    const matches = orgs.filter(org => {
        if (Array.isArray(org.allowedDomains) && org.allowedDomains.length > 0) {
            return org.allowedDomains.includes(userDomain);
        }
        if (!confirmedContactOrgIds.has(org.id) || !org.email || !org.email.includes('@')) return false;
        return org.email.split('@')[1].toLowerCase() === userDomain;
    });
    return matches.length === 1 ? matches[0] : null;
}

/**
 * Decide the org placement fields for a brand-new SSO user, honouring the
 * matched org's auto-approve setting. Pure — returns the fields to persist.
 *
 * - no org matched         → org-less active account (consumer / "no org" screen)
 * - org.autoApproveSSO true → active member, org default groups applied
 * - org.autoApproveSSO false → pending member (awaits admin approval), no groups
 *
 * This closes the approval-bypass: stamping the org with the default 'active'
 * status directly would mean the auto-approve/pending decision (which lives in
 * a later block guarded by !userHasOrg) never ran.
 *
 * `existingGroups` is for the second caller — binding a pre-existing org-less
 * account found by domain match, which must keep the groups it already had. The
 * create path passes nothing, so its result is unchanged.
 */
function planNewSSOUserPlacement(org, /** @type {{ existingGroups?: string[], allGroups?: Array<Record<string, any>> }} */ { existingGroups = [], allGroups } = {}) {
    const keep = Array.isArray(existingGroups) ? existingGroups : [];
    if (!org || !org.id) {
        return { organizationId: '', orgRole: '', status: 'active', groups: [...keep] };
    }
    if (org.autoApproveSSO === true) {
        let defaults = Array.isArray(org.defaultGroups) ? org.defaultGroups : [];
        // With the group list at hand (both callers pass it), a default group
        // must be the org's own or a plain global group (admin/defaultGroupFilter).
        if (Array.isArray(allGroups)) {
            defaults = require('./admin/defaultGroupFilter.mts').applicableDefaultGroups(defaults, allGroups, org.id);
        }
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
 * victim's row (a swallowed failed create would build the session around
 * whatever row already held the id — an account-takeover path). On
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
    emailLinkAllowed,
    resolveOrgByEmailDomain,
    planNewSSOUserPlacement,
    AZURE_OID_REGEX,
};
