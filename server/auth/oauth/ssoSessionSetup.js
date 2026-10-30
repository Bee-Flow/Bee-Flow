// @typecheck strict
/**
 * The session half of the OAuth callback (./providerCallbackRoutes.js): where
 * the user stands with an organisation (binding an org-less account by
 * domain or tenant), and the session fields, token vault and encryption
 * flags written once the route's account-status gate has passed.
 */

const log = require('../../telemetry/log');
const userStore = require('../../stores/userStore');
const { getOrCreateSSOUserDEKCompat } = require('../encryption');
const { resolveOrgByEmailDomain, planNewSSOUserPlacement } = require('../ssoUserResolver');
const { parseGroupIds, orgIdsForUser } = require('../orgMembership');
const { getEffectiveFreeEmailDomains } = require('../../utils/freeEmailDomains');
// Shared with loginRoutes and the admin gate — this was a verbatim copy that
// read `allowed_features` alone, i.e. only the plan-grant half of entitlement,
// so an org entitled via its licence tier failed it and `zk` silently wrote
// plaintext. See stores/encryptionAvailability.js for the full note.
const { isSsoPinRequiredForUser } = require('../../stores/encryptionAvailability');
const { _vaultUpsertSafe } = require('./shared');
const microsoftLogin = require('./microsoftLogin');

/**
 * The fresh row, whether it belongs to an organisation (binding it by
 * domain/tenant when it does not), and whether it awaits approval.
 * @param {{ provider: string, user: import('./providerCallbackRoutes').OAuthUser, msTenant?: string, signupIntent?: import('./ssoUserProvisioning').SignupIntent | null }} opts
 */
async function resolveOrgStanding({ provider, user, msTenant, signupIntent }) {
    // Check if user belongs to any organisation.
    //
    // Membership is the union documented in auth/orgMembership.js:
    // users.organizationId ∪ { g.organizationId | g ∈ user.groups }. Use
    // that shared helper rather than re-deriving it — a hand-rolled copy
    // reading `g.organization_id` is wrong: the groups table
    // column is quoted camelCase "organizationId" (userStore.js:106) and
    // getAllGroups spreads the row verbatim, so the group path would never
    // match. Group-only members (blank users.organizationId — the shape
    // azureGroupSync produces) would therefore look org-less and get
    // domain-matched into whichever org owns their email domain, or be
    // shown the "No Organisation Found" gate on every SSO login.
    const freshUser = await userStore.getUser(user.id);
    const userGroups = parseGroupIds(freshUser);
    let userHasOrg = false;
    if (userGroups.length > 0) {
        const allGroups = await userStore.getAllGroups();
        userHasOrg = orgIdsForUser(freshUser, allGroups).size > 0;
    }
    // Also check if user has orgRole set directly
    if (freshUser?.orgRole) userHasOrg = true;
    // Also check if user has an organizationId set directly (e.g. added manually by admin)
    if (freshUser?.organizationId) userHasOrg = true;

    // A personal account has no organisation by definition: never domain-match
    // it into one, and never show it the "No Organisation Found" gate.
    const isPersonalAccount = signupIntent?.accountType === 'consumer';

    // If user has no org, try domain-matching
    let pendingApproval = false;
    if (!userHasOrg && !isPersonalAccount && (provider === 'microsoft' || (user.email && user.email.includes('@')))) {
        const matchingOrg = provider === 'microsoft'
            ? await microsoftLogin.trustedMicrosoftOrg(user, msTenant, userStore)
            : resolveOrgByEmailDomain(user.email ?? '', await userStore.getAllOrganizations(), await getEffectiveFreeEmailDomains());

        if (matchingOrg) {
            // Same auto-approve/pending decision the create path makes, from
            // the same helper — this block only differs in that it merges the
            // groups the pre-existing account already had.
            const bind = planNewSSOUserPlacement(matchingOrg, { existingGroups: userGroups || [] });
            await userStore.updateUser(user.id, {
                groups: bind.groups,
                organizationId: bind.organizationId,
                orgRole: bind.orgRole,
                status: bind.status,
            });
            pendingApproval = bind.status === 'pending';
            userHasOrg = true; // They belong to an org, pending or not
            log.info(`[OAuth] SSO user ${user.id} bound to org "${matchingOrg.name}" as ${bind.status}`
                + (bind.status === 'active' ? ` with ${bind.groups.length} groups` : ' (awaiting admin approval)'));
        }
    }

    // Check if existing user is pending — but never gate an org founder/owner
    // or system admin (they are the org's approver; no one above them).
    const isOrgOwnerOrAdmin = freshUser?.orgRole === 'org_admin' || freshUser?.role === 'admin';
    if (freshUser?.status === 'pending' && !isOrgOwnerOrAdmin) {
        pendingApproval = true;
    }
    return { freshUser, userHasOrg, pendingApproval, isPersonalAccount };
}

/**
 * Write the signed-in session: identity, tokens (and their vault copy), approval and encryption flags.
 * @param {{ req: import('express').Request, provider: string, user: import('./providerCallbackRoutes').OAuthUser, freshUser: import('./ssoUserProvisioning').UserRow | null, tokenData: import('./providerCallbackRoutes').OAuthTokenResponse, pendingApproval: boolean, userHasOrg: boolean, isPersonalAccount: boolean }} opts
 */
async function writeOAuthSession({ req, provider, user, freshUser, tokenData, pendingApproval, userHasOrg, isPersonalAccount }) {
    let microsoftLoginIdentity;
    if (provider === 'microsoft') {
        microsoftLoginIdentity = await require('../../stores/microsoftIdentityStore').getIdentityBinding(user.id);
        if (!microsoftLoginIdentity || microsoftLoginIdentity.azureTenantId !== user.azureTenantId
            || microsoftLoginIdentity.azureUserId !== user.azureUserId) throw new Error('Microsoft account binding changed during login');
    }
    req.session.accessToken = tokenData.access_token;
    req.session.refreshToken = tokenData.refresh_token;
    req.session.user = user;
    req.session.isAuthenticated = true;
    req.session.isAdmin = freshUser?.role === 'admin';
    req.session.oauthProvider = provider;
    if (provider === 'microsoft') {
        req.session.microsoftIdentityVersion = 2;
        req.session.microsoftLoginIdentity = microsoftLoginIdentity;
    } else {
        delete req.session.microsoftIdentityVersion;
        delete req.session.microsoftLoginIdentity;
        delete req.session.oauthConnectionId;
    }
    // Remember what the provider ACTUALLY granted, so a later token refresh
    // re-requests that set instead of a hardcoded list — a narrower refresh
    // silently downgrades the grant (see microsoftRefreshScope).
    if (tokenData.scope) req.session.oauthScope = tokenData.scope;

    // Long-lived encrypted vault copy for unattended work (automations, App
    // Studio mailbox syncs). The vault key is org-scoped, so an account
    // without an organisation needs the same per-user scope the connector
    // routes already use — skipping the write there meant those users' work
    // silently stopped the moment their session ended, even though they had
    // just granted us the tokens.
    const vaultOrgId = freshUser?.organizationId || user?.organizationId || `user:${user.id}`;
    await _vaultUpsertSafe({ userId: user.id, orgId: vaultOrgId, provider, tokenData });
    if (pendingApproval) {
        req.session.pendingApproval = true;
    }
    if (!userHasOrg && !isPersonalAccount) {
        req.session.noOrganization = true;
        log.info(`[OAuth/${provider}] User has no organization`);
    }
    // Handle SSO encryption with backward compatibility
    log.info(`[OAuth/${provider}] Checking encryption for user ${user.id}...`);
    // No PIN on the managed tier: the org escrow holds the key.
    const encryptionEnabled = await isSsoPinRequiredForUser(user.id);
    log.info(`[OAuth/${provider}] SSO encryption PIN required: ${encryptionEnabled}`);
    const ssoResult = await getOrCreateSSOUserDEKCompat(user.id, encryptionEnabled);
    log.info(`[OAuth/${provider}] SSO DEK result — hasKey: ${!!ssoResult.encryptionKey}, needsSetup: ${!!ssoResult.needsEncryptionSetup}, needsPin: ${!!ssoResult.needsEncryptionPin}`);
    if (ssoResult.encryptionKey) {
        req.session.encryptionKey = ssoResult.encryptionKey;
    }
    if (ssoResult.needsEncryptionSetup) {
        req.session.needsEncryptionSetup = true;
    }
    if (ssoResult.needsEncryptionPin) {
        req.session.needsEncryptionPin = true;
    }
}

module.exports = { resolveOrgStanding, writeOAuthSession };
