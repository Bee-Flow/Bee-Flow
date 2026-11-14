// @typecheck strict
/**
 * The account half of the OAuth callback (./providerCallbackRoutes.js): find
 * the local user for a provider identity, or create one (signup wizard or
 * plain SSO arrival). Every refusal returns { error } with the code the
 * route puts in its `?error=` redirect; anything thrown ends as
 * `callback_failed` there.
 */

const log = require('../../telemetry/log');
const userStore = require('../../stores/userStore');
const {
    deriveLocalUserId,
    deriveAvailableLocalUserId,
    resolveExistingSSOUser,
    planNewSSOUserPlacement,
} = require('../ssoUserResolver');
const { orgForNewAccount } = require('../orgDomainMatch.mts');
const { checkWebSignupAllowed } = require('../signupGuards');
const accountProvisioning = require('../accountProvisioning');
const microsoftLogin = require('./microsoftLogin');
const { ssoIdentities, SSO_IDENTITY_PROVIDERS } = require('../ssoIdentityStore.mts');
const { claimSessionInvite, releaseInvite } = require('./oauthInvite.mts');

/** @typedef {import('./providerCallbackRoutes').OAuthUser} OAuthUser */
/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getUser>>>} UserRow */
/** @typedef {import('../accountProvisioning').Placement} Placement */
/** @typedef {ReturnType<typeof accountProvisioning.normalizeSignupIntent>} SignupIntent */
/** @typedef {{ name?: string } | null | undefined} PreResolvedOrg */

/**
 * A matched account: refresh its profile fields, never its role or org.
 * @param {{ provider: string, user: OAuthUser, existingUser: UserRow, branch: string }} opts
 */
async function updateMatchedUser({ provider, user, existingUser, branch }) {
    // Canonical id comes from the stored record. Do NOT overwrite
    // role, orgRole, organizationId, groups, or status here — those
    // are managed by the directory sync and admin flows.
    user.id = existingUser.id;
    await userStore.updateUser(existingUser.id, {
        displayName: user.displayName,
        firstName: user.firstName || existingUser.firstName,
        lastName: user.lastName || existingUser.lastName,
        email: user.email || existingUser.email,
        avatar: user.picture || existingUser.avatar,
        avatarType: user.picture ? 'url' : existingUser.avatarType,
    });
    log.info(`[OAuth/${provider}] Matched existing user via branch=${branch} → ${existingUser.id} (azureUserId=${existingUser.azureUserId || 'none'}, org=${existingUser.organizationId || 'none'})`);
}

/**
 * A new user: the signup gate, a collision-safe local id, and where the
 * account goes (the wizard's choice, or the org its e-mail/tenant names).
 * @param {{ req: import('express').Request, provider: string, user: OAuthUser, msTenant?: string }} opts
 */
async function planNewSsoUser({ req, provider, user, msTenant }) {
    /** @type {accountProvisioning.SignupIntent | null} */
    let signupIntent = null;

    // A truly new OAuth user = a signup. The wizard-driven path
    // (pendingSignup) runs its own guards inside prepareAccountPlacement;
    // a plain SSO arrival is gated here. Existing users matched above are
    // never gated.
    const pendingSignup = req.session.pendingSignup || null;
    if (!pendingSignup) {
        const gate = await checkWebSignupAllowed(req);
        if (!gate.ok) {
            log.info(`[OAuth/${provider}] Signup blocked (${gate.code}) for ${log.textForLog(user.email)}`);
            const reason = gate.code === 'CONNECTOR_ONLY' ? 'signup_connector_only' : 'signup_geo_blocked';
            return { error: reason };
        }
    }
    // Truly new user. Capture the provider-stable subject id (Google
    // `sub` / Azure oid, still on user.id here) BEFORE we overwrite it,
    // so a colliding local id can be disambiguated and can't be used to
    // hijack an unrelated account that happens to share the email
    // local-part. Then derive a collision-safe local id.
    const providerKey = user.azureUserId || user.id || '';
    const localId = await deriveAvailableLocalUserId(
        user.email,
        providerKey,
        async (id) => !!(await userStore.getUser(id)),
    );
    user.id = localId;

    let preResolvedOrg = null;
    let placement;

    if (pendingSignup) {
        // The signup wizard's org/consumer choice. Guards, org creation
        // and the domain-collision check all run HERE, before the user
        // row exists — so a rejected signup can't leave a founder
        // stranded without an organisation (which is exactly what the
        // old create-user-then-create-org ordering did).
        delete req.session.pendingSignup;
        const wizard = await wizardPlacement({ req, provider, user, pendingSignup });
        if ('error' in wizard) return { error: wizard.error };
        ({ signupIntent, placement } = wizard);
    } else {
        // Pre-resolve the organisation by email domain so the record
        // isn't orphaned (auth/orgDomainMatch.mts: never a free/public email
        // provider, a contact address only once its domain is confirmed, and
        // nobody when two organisations match). This is the only place an
        // account is placed by its domain.
        // Microsoft: by the verified tenant, never by the e-mail domain (microsoftLogin.js).
        if (provider === 'microsoft') preResolvedOrg = await microsoftLogin.trustedMicrosoftOrg(user, msTenant, userStore);
        else if (user.email && user.email.includes('@')) {
            preResolvedOrg = await orgForNewAccount(user.email, user.emailVerified === true);
        }
        // Honour the matched org's auto-approve setting at create time (org
        // default groups on auto-approve; 'pending' status otherwise). This
        // is where the approval decision now lives — the later !userHasOrg
        // block only handles pre-existing org-less users.
        placement = planNewSSOUserPlacement(preResolvedOrg, { allGroups: await userStore.getAllGroups() });
    }

    return { signupIntent, placement, preResolvedOrg, localId };
}

/**
 * The wizard's placement. An invited signup claims the session's invitation
 * for the provider's address first, as the password signup does
 * (oauthInvite.mts); the claim is handed back when the placement fails.
 * @param {{ req: import('express').Request, provider: string, user: OAuthUser, pendingSignup: Record<string, any> }} opts
 * @returns {Promise<{ error: string } | { signupIntent: SignupIntent, placement: Placement }>}
 */
async function wizardPlacement({ req, provider, user, pendingSignup }) {
    /** @type {import('./oauthInvite.mts').InvitationRow | null} */
    let inviteData = null;
    /** @type {string | null} */
    let inviteToken = null;
    if (pendingSignup.invite) {
        const claim = await claimSessionInvite(req.session, user.email);
        if ('error' in claim) return { error: claim.error };
        ({ inviteData, inviteToken } = claim);
    }
    try {
        const signupIntent = accountProvisioning.normalizeSignupIntent(
            { ...pendingSignup, email: user.email },
            { provider, channel: 'oauth', inviteData, inviteToken },
        );
        if (signupIntent.invite) signupIntent.invite.claimed = true;
        const placement = await accountProvisioning.prepareAccountPlacement(signupIntent, { req });
        return { signupIntent, placement };
    } catch (e) {
        await releaseInvite(inviteData);
        if (e instanceof accountProvisioning.SignupError) {
            log.warn(`[OAuth/${provider}] pending signup rejected (${e.code}): ${/** @type {Error} */ (e).message}`);
            return { error: e.oauthCode };
        }
        throw e;
    }
}

/**
 * Create the row under the seat cap; a lost race or an id collision is told apart here.
 * @param {{ provider: string, user: OAuthUser, localId: string, placement: Placement }} opts
 */
async function createSsoUser({ provider, user, localId, placement }) {
    let createOk = false;
    try {
        const r = await userStore.createUserWithSeatCheck({
            id: localId,
            username: user.email || localId,
            displayName: user.displayName,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            avatar: user.picture || null,
            avatarType: user.picture ? 'url' : null,
            role: 'user',
            groups: placement.groups,
            orgRole: placement.orgRole,
            status: placement.status,
            azureUserId: user.azureUserId || null,
            azureTenantId: user.azureTenantId || null,
            organizationId: placement.organizationId,
        }, { strict: true });

        if (r.created) {
            createOk = true;
        } else {
            // Not created: either a benign lost race on our own id (a
            // double callback for the SAME identity) or a collision with
            // an UNRELATED account. Distinguish by comparing the existing
            // row's email to the authenticated identity. Never build a
            // session around a row whose email differs — that is the
            // account-takeover path — fail the login instead.
            const existing = await userStore.getUser(localId);
            const sameIdentity = provider === 'microsoft'
                ? existing && existing.azureUserId === user.azureUserId && existing.azureTenantId === user.azureTenantId
                : existing && existing.email
                && existing.email.toLowerCase() === String(user.email || '').toLowerCase();
            if (sameIdentity) {
                createOk = true;
            } else {
                if (existing) {
                    log.error(`[OAuth/${provider}] sso_id_collision — id=${localId} email=${log.textForLog(user.email)} collides with an existing account whose email=${log.textForLog(existing.email)}; aborting login`);
                } else {
                    log.error('[OAuth] auto-provision failed:', r.reason, r.error || '');
                }
                return { error: 'signup_failed' };
            }
        }
    } catch (e) {
        if (e instanceof userStore.SeatCapExceededError) {
            return { error: 'seat_cap_exceeded' };
        }
        throw e;
    }
    if (!createOk) {
        return { error: 'signup_failed' };
    }
    log.info(`[OAuth/${provider}] Created new user via branch=create → ${localId} (azureUserId=${user.azureUserId || 'none'}, org=${placement.organizationId || 'none'}, status=${placement.status})`);

    return {};
}

/**
 * After the row exists: the wizard's finalisation, or locale + welcome mail.
 * @param {{ req: import('express').Request, user: OAuthUser, localId: string, placement: Placement, signupIntent?: SignupIntent | null, preResolvedOrg?: PreResolvedOrg }} opts
 */
async function finishNewSsoUser({ req, user, localId, placement, signupIntent, preResolvedOrg }) {
    if (signupIntent) {
        // Privacy shield, consent ledger, locale, onboarding seed, trial
        // and welcome email — the same sequence the password signup runs.
        await accountProvisioning.finalizeAccount({
            userId: localId,
            email: user.email,
            displayName: user.displayName,
            intent: signupIntent, placement, req,
        });
    } else {
        // Plain SSO arrival (no signup wizard). SSO accounts skip email
        // verification — the IdP already proved the address. Persist the
        // preferred locale and send the welcome email once, but only when
        // the account is actually active (a domain match may have landed
        // it in 'pending').
        try {
            const { resolveSignupLocale } = require('../signupGuards');
            const ssoLocale = await resolveSignupLocale(req);
            await userStore.updateUser(localId, { preferredLocale: ssoLocale });
            if (user.email) {
                setImmediate(async () => {
                    try {
                        const row = await userStore.getUser(localId);
                        if (!row || (row.status ?? 'active') !== 'active') return;
                        const claimed = await userStore.claimNotification('user', localId, 'welcome_email', /** @type {string} */ (user.email));
                        if (!claimed) return;
                        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
                        const orgName = preResolvedOrg?.name || '';
                        const { sendWelcomeEmail } = require('../../utils/emailService');
                        await sendWelcomeEmail({ email: /** @type {string} */ (user.email), displayName: user.displayName, loginUrl: clientHost, orgName, locale: ssoLocale });
                    } catch (e) { log.warn('[OAuth] welcome email failed:', /** @type {Error} */ (e).message); }
                });
            }
        } catch (e) { log.warn('[OAuth] post-create locale/welcome failed:', /** @type {Error} */ (e).message); }
    }
}

/**
 * Whether this identity must be linked by an administrator instead of signing
 * in: a Microsoft identity with no bound account that needs an admin link, or
 * an account with this e-mail that this provider's identity may not sign in to
 * (ssoUserResolver.emailLinkAllowed). Never a second account in either case.
 * @param {{ provider: string, user: OAuthUser, existingUser: UserRow | null, branch: string }} opts
 */
async function linkRefused({ provider, user, existingUser, branch }) {
    if (provider === 'microsoft' && !existingUser && await microsoftLogin.requireAdminLink(user, userStore)) return true;
    if (branch === 'emailRefused') {
        log.warn(`[OAuth/${provider}] Refused e-mail link to an existing account`);
        return true;
    }
    return false;
}

/**
 * What the resolver gets to know about the provider identity.
 * @param {string} provider
 * @param {OAuthUser} user
 * @param {string} localId
 * @returns {import('../ssoUserResolver').SsoIdentity}
 */
function identityOf(provider, user, localId) {
    return {
        azureUserId: user.azureUserId || null, azureTenantId: user.azureTenantId || null, email: user.email, localId, provider,
        subject: user.subject || null, emailVerified: user.emailVerified === true, ncBaseUrl: user.ncBaseUrl || null, legacyRawUid: user.legacyRawUid || null,
    };
}

/**
 * A new account: plan, create, record its subject, finish.
 * @param {{ req: import('express').Request, provider: string, user: OAuthUser, msTenant?: string, identities: import('../ssoIdentityStore.mts').SsoIdentityStore | null }} opts
 * @returns {Promise<{ error?: string, signupIntent?: SignupIntent | null }>}
 */
async function makeNewSsoUser({ req, provider, user, msTenant, identities }) {
    const plan = await planNewSsoUser({ req, provider, user, msTenant });
    if (plan.error) return { error: plan.error };
    const { placement, preResolvedOrg, localId, signupIntent } = /** @type {Exclude<typeof plan, { error: unknown }>} */ (plan);
    const created = await createSsoUser({ provider, user, localId, placement });
    if (created.error) return created;
    if (identities && !(await recordIdentity(identities, localId, provider, user))) return { error: 'sso_link_required' };
    await finishNewSsoUser({ req, user, localId, placement, signupIntent, preResolvedOrg });
    return { signupIntent };
}

/**
 * Whether this provider's sign-ins are bound by (provider, subject).
 * @param {string} provider
 * @param {OAuthUser} user
 */
function boundBySubject(provider, user) {
    return SSO_IDENTITY_PROVIDERS.includes(provider) && typeof user.subject === 'string' && user.subject !== '';
}

/**
 * Record (provider, subject) for the account the sign-in resolved to. False
 * when the subject already belongs to another account (never moved).
 * @param {import('../ssoIdentityStore.mts').SsoIdentityStore} identities
 * @param {string} userId
 * @param {string} provider
 * @param {OAuthUser} user
 */
async function recordIdentity(identities, userId, provider, user) {
    const result = await identities.link(userId, provider, String(user.subject));
    if (result === 'taken') log.warn(`[OAuth/${provider}] Refused: the provider identity belongs to another account`);
    return result !== 'taken';
}

/**
 * Resolve (or create) the local account behind a provider identity. Mutates
 * `user.id` to the canonical local id. Returns { signupIntent, msTenant }
 * or { error }.
 * @returns {Promise<{ error?: string, signupIntent?: SignupIntent | null, msTenant?: string }>}
 * @param {{ req: import('express').Request, provider: string, user: OAuthUser, config: { providers?: { microsoft?: { tenantId?: string } } } }} opts
 */
async function resolveSsoUser({ req, provider, user, config }) {
    // Non-Microsoft providers (Nextcloud, legacy) historically used the
    // provider-issued id as the local id. Preserve that as the provisional
    // localId so the resolver's legacy-id fallback can still find them.
    // For Microsoft, the Azure OID lives on user.azureUserId — the local
    // id is derived/resolved below.
    const provisionalLocalId = user.id || deriveLocalUserId(user.email, user.azureUserId);

    const identities = boundBySubject(provider, user) ? ssoIdentities() : null;
    let { user: existingUser, branch } = await resolveExistingSSOUser(identityOf(provider, user, provisionalLocalId), userStore, identities);

    // Installations from before tenant binding: link the old account on first login when the
    // verified token comes from the configured concrete tenant and the match is unambiguous.
    // The tenant the administrator configured for the connection this sign-in
    // came through: the primary app's, or the additional tenant's.
    const msTenant = provider === 'microsoft'
        ? require('./microsoftConnections.mts').microsoftCredentialsFor(config, req.session.oauthConnectionId)?.tenantId
        : undefined;
    if (provider === 'microsoft' && !existingUser && await microsoftLogin.autoLinkOnLogin(user, msTenant)) {
        ({ user: existingUser, branch } = await resolveExistingSSOUser(
            { azureUserId: user.azureUserId, azureTenantId: user.azureTenantId, email: user.email, localId: provisionalLocalId, provider }, userStore));
    }
    if (await linkRefused({ provider, user, existingUser, branch })) return { error: 'sso_link_required' };

    // Set when this callback is completing a signup started in the wizard
    // (req.session.pendingSignup). Read further down to keep a personal
    // account out of the org domain-matching and no-organisation gate.
    /** @type {accountProvisioning.SignupIntent | null | undefined} */
    let signupIntent = null;

    if (existingUser) {
        if (identities && !(await recordIdentity(identities, existingUser.id, provider, user))) return { error: 'sso_link_required' };
        await updateMatchedUser({ provider, user, existingUser, branch });
    } else {
        const made = await makeNewSsoUser({ req, provider, user, msTenant, identities });
        if (made.error) return made;
        signupIntent = made.signupIntent;
    }
    return { signupIntent, msTenant };
}

module.exports = { resolveSsoUser, boundBySubject };
