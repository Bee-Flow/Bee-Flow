// @typecheck noImplicitAny
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
    resolveOrgByEmailDomain,
    planNewSSOUserPlacement,
} = require('../ssoUserResolver');
const { getEffectiveFreeEmailDomains } = require('../../utils/freeEmailDomains');
const { checkWebSignupAllowed } = require('../signupGuards');
const accountProvisioning = require('../accountProvisioning');
const microsoftLogin = require('./microsoftLogin');

/** @typedef {import('./providerCallbackRoutes').OAuthUser} OAuthUser */
/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getUser>>>} UserRow */
/** @typedef {{ organizationId: string, orgRole: string, status: string, groups: string[] }} Placement */
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
    let signupIntent = null;

    // A truly new OAuth user = a signup. The wizard-driven path
    // (pendingSignup) runs its own guards inside prepareAccountPlacement;
    // a plain SSO arrival is gated here. Existing users matched above are
    // never gated.
    const pendingSignup = req.session.pendingSignup || null;
    if (!pendingSignup) {
        const gate = await checkWebSignupAllowed(req);
        if (!gate.ok) {
            log.info(`[OAuth/${provider}] Signup blocked (${gate.code}) for ${user.email || 'unknown'}`);
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
        try {
            signupIntent = accountProvisioning.normalizeSignupIntent(
                { ...pendingSignup, email: user.email },
                { provider, channel: 'oauth' },
            );
            placement = await accountProvisioning.prepareAccountPlacement(signupIntent, { req });
        } catch (e) {
            if (e instanceof accountProvisioning.SignupError) {
                log.warn(`[OAuth/${provider}] pending signup rejected (${e.code}): ${e.message}`);
                return { error: e.oauthCode };
            }
            throw e;
        }
    } else {
        // Pre-resolve the organisation by email domain so the record
        // isn't orphaned — never for a free/public email provider
        // (nobody owns gmail.com; that is the cross-tenant bug).
        // Microsoft: by the verified tenant, never by the e-mail domain (microsoftLogin.js).
        if (provider === 'microsoft') preResolvedOrg = await microsoftLogin.trustedMicrosoftOrg(user, msTenant, userStore);
        else if (user.email && user.email.includes('@')) {
            const allOrgs = await userStore.getAllOrganizations();
            const freeDomains = await getEffectiveFreeEmailDomains();
            preResolvedOrg = resolveOrgByEmailDomain(user.email, allOrgs, freeDomains);
        }
        // Honour the matched org's auto-approve setting at create time (org
        // default groups on auto-approve; 'pending' status otherwise). This
        // is where the approval decision now lives — the later !userHasOrg
        // block only handles pre-existing org-less users.
        placement = planNewSSOUserPlacement(preResolvedOrg);
    }

    return { signupIntent, placement, preResolvedOrg, localId };
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
                    log.error(`[OAuth/${provider}] sso_id_collision — id=${localId} email=${log.textForLog(user.email)} collides with existing email=${existing.email || 'unknown'}; aborting login`);
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
                        const claimed = await userStore.claimNotification('user', localId, 'welcome_email', user.email);
                        if (!claimed) return;
                        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
                        const orgName = preResolvedOrg?.name || '';
                        const { sendWelcomeEmail } = require('../../utils/emailService');
                        await sendWelcomeEmail({ email: user.email, displayName: user.displayName, loginUrl: clientHost, orgName, locale: ssoLocale });
                    } catch (e) { log.warn('[OAuth] welcome email failed:', e.message); }
                });
            }
        } catch (e) { log.warn('[OAuth] post-create locale/welcome failed:', e.message); }
    }
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

    let { user: existingUser, branch } = await resolveExistingSSOUser(
        { azureUserId: user.azureUserId || null, azureTenantId: user.azureTenantId || null, email: user.email, localId: provisionalLocalId },
        userStore,
    );

    // Installations from before tenant binding: link the old account on first login when the
    // verified token comes from the configured concrete tenant and the match is unambiguous.
    const msTenant = config.providers?.microsoft?.tenantId;
    if (provider === 'microsoft' && !existingUser && await microsoftLogin.autoLinkOnLogin(user, msTenant)) {
        ({ user: existingUser, branch } = await resolveExistingSSOUser(
            { azureUserId: user.azureUserId, azureTenantId: user.azureTenantId, email: user.email, localId: provisionalLocalId }, userStore));
    }
    if (provider === 'microsoft' && !existingUser && await microsoftLogin.requireAdminLink(user, userStore)) {
        return { error: 'sso_link_required' };
    }

    // Set when this callback is completing a signup started in the wizard
    // (req.session.pendingSignup). Read further down to keep a personal
    // account out of the org domain-matching and no-organisation gate.
    let signupIntent = null;

    if (existingUser) {
        await updateMatchedUser({ provider, user, existingUser, branch });
    } else {
        const plan = await planNewSsoUser({ req, provider, user, msTenant });
        if (plan.error) return plan;
        const { placement, preResolvedOrg, localId } = plan;
        signupIntent = plan.signupIntent;
        const created = await createSsoUser({ provider, user, localId, placement });
        if (created.error) return created;
        await finishNewSsoUser({ req, user, localId, placement, signupIntent, preResolvedOrg });
    }
    return { signupIntent, msTenant };
}

module.exports = { resolveSsoUser };
