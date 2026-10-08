// @typecheck
/**
 * Multi-provider OAuth callback — GET /callback/:provider: state/PKCE check,
 * token exchange, user-info fetch, SSO provisioning + org binding, and the
 * session handoff (popup postMessage or redirect).
 *
 * NO REQUEST SCHEMA HERE, on purpose. The query string on a callback is
 * written by the identity provider, not by us: Google, Microsoft and Nextcloud
 * each add their own parameters (`authuser`, `hd`, `prompt`, `session_state`,
 * `scope`, …) and add more without asking. A `.strict()` query would turn a
 * provider's next release into "sign-in is broken", and the fields that decide
 * anything — `state` against the session, `code` through the token exchange —
 * are already checked where they are used, which is the check that matters.
 */

const express = require('express');

/**
 * A provider's token-endpoint JSON (RFC 6749 §5.1 / §5.2).
 * @typedef {{ access_token?: string, refresh_token?: string, expires_in?: number|string, scope?: string,
 *             token_type?: string, id_token?: string, error?: string, error_description?: string,
 *             [key: string]: any }} OAuthTokenResponse
 */
/**
 * The session user built from a provider profile, before provisioning.
 * @typedef {{ id?: string, azureUserId?: string|null, azureTenantId?: string|null, displayName?: string, firstName?: string, lastName?: string,
 *             email?: string, picture?: string, provider: string, organizationId?: string, [key: string]: any }} OAuthUser
 */
const log = require('../../telemetry/log');
const router = express.Router();

const { loadConfig, OAUTH_PROVIDERS } = require('../permissions');
const { getOrCreateSSOUserDEKCompat } = require('../encryption');
const { establishSession } = require('../establishSession');
const { isLoginBlockedAccount, REFUSAL } = require('../accountStatusGate');
const userStore = require('../../stores/userStore');
const { syncUserGroupsOnLogin } = require('../../integrations/azureGroupSync');
const {
    deriveLocalUserId,
    deriveAvailableLocalUserId,
    resolveExistingSSOUser,
    resolveOrgByEmailDomain,
    planNewSSOUserPlacement,
} = require('../ssoUserResolver');
const { parseGroupIds, orgIdsForUser } = require('../orgMembership');
const { getEffectiveFreeEmailDomains } = require('../../utils/freeEmailDomains');
const { checkWebSignupAllowed } = require('../signupGuards');
const accountProvisioning = require('../accountProvisioning');
const { _vaultUpsertSafe, oauthStatesMatch, knownNativeAppRedirect } = require('./shared');
const microsoftLogin = require('./microsoftLogin');

/**
 * Check if encryption is enabled for a user based on their org's subscription plan.
 * Admin users always have encryption enabled.
 * Encryption is a paid feature — disabled by default unless plan explicitly includes it.
 */
/**
 * Save the session and respond with either the popup-close HTML (when the
 * OAuth flow was launched in a popup/iframe) or a normal redirect. Shared by
 * the org-signup path and the consumer-signup early-return path so the two
 * cannot drift.
 */
function _respondOAuthLogin(req, res, provider, returnTo, userId) {
    log.info(`[OAuth/${provider}] Saving session and redirecting to: ${returnTo}`);
    (async () => {
        // H11: rotate the session id at the moment of authentication
        // (session-fixation defense). The canonical user/isAdmin were set
        // on the pre-regenerate session by both callback paths just before
        // calling this; `preserve` carries the popup/pickup handoff keys
        // and the provider token material written pre-auth — read below
        // for the pickup deposit and on later requests (nextcloudClient
        // reads nextcloudUid / nextcloudTokenExpiresAt).
        try {
            await establishSession(req, {
                user: req.session.user,
                isAdmin: req.session.isAdmin || false,
                preserve: [
                    'oauthPopup', 'oauthPickupId', 'oauthAppRedirect',
                    'accessToken', 'refreshToken', 'oauthProvider', 'microsoftIdentityVersion', 'microsoftLoginIdentity',
                    'nextcloudUid', 'nextcloudTokenExpiresAt',
                    'encryptionKey', 'needsEncryptionSetup', 'needsEncryptionPin',
                    'pendingApproval', 'noOrganization',
                ],
                audit: { method: `oauth:${provider}` },
            });
            log.info(`[OAuth/${provider}] Login complete, redirecting user ${userId}`);
        } catch (err) {
            log.error(`[OAuth/${provider}] SESSION SAVE ERROR:`, err);
        }

        if (req.session.oauthPopup) {
            const pickupId = req.session.oauthPickupId;
            // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- knownNativeAppRedirect returns one of the fixed NATIVE_APP_REDIRECTS literals or null, never the session value
            const appRedirect = knownNativeAppRedirect(req.session.oauthAppRedirect);
            delete req.session.oauthPopup;
            delete req.session.oauthPickupId;
            delete req.session.oauthAppRedirect;
            req.session.save();

            let deposited = false;
            if (pickupId) {
                try {
                    const { setSessionToken, setPickup, generateToken } = require('../../utils/sessionToken');
                    const appPasswordData = await userStore.getAppPassword(userId);
                    const sessionToken = generateToken();
                    await setSessionToken(sessionToken, {
                        user: req.session.user,
                        accessToken: req.session.accessToken,
                        refreshToken: req.session.refreshToken,
                        oauthProvider: req.session.oauthProvider,
                        microsoftIdentityVersion: req.session.microsoftIdentityVersion,
                        microsoftLoginIdentity: req.session.microsoftLoginIdentity,
                        nextcloudUid: req.session.nextcloudUid,
                        appPassword: appPasswordData,
                        isAuthenticated: true,
                        isAdmin: req.session.isAdmin || false,
                        // The gates /auth/user reads straight off the session
                        // (auth/login/currentUserRoutes.js:75-82). Without them
                        // a bridged client is told a user awaiting approval is
                        // approved, and — on a zero-knowledge product — never
                        // prompts for encryption setup, so the account silently
                        // runs without a DEK.
                        //
                        // Deliberately NOT `encryptionKey`: that would park key
                        // material in the bridge store, which is exactly what
                        // the zero-knowledge design exists to prevent. The
                        // client runs its own setup/PIN flow off these flags.
                        needsEncryptionSetup: req.session.needsEncryptionSetup || false,
                        needsEncryptionPin: req.session.needsEncryptionPin || false,
                        pendingApproval: req.session.pendingApproval || false,
                        noOrganization: req.session.noOrganization || false,
                    });
                    await setPickup(pickupId, { sessionToken });
                    deposited = true;
                    log.info(`[OAuth/${provider}] Pickup ${pickupId} deposited`);
                } catch (pickupErr) {
                    log.error(`[OAuth/${provider}] Pickup deposit failed:`, pickupErr.message);
                }
            }

            // A native client goes back to its own scheme. That 302 is not a
            // navigation anybody sees — it is what makes Android deliver an
            // ACTION_VIEW intent to the app, which is the ONLY thing that
            // closes a Custom Tab (expo-web-browser's WebBrowserPackage calls
            // finishAndRemoveTask on its proxy activity from onNewIntent). It
            // carries nothing: any app on the device may register a private
            // scheme (RFC 8252 §8.6), and appending the pickup id would hand a
            // scheme hijacker the claim key to a live session for no benefit —
            // the legitimate client minted that id itself and claims the
            // one-shot token over its own TLS connection.
            //
            // Sent even when the deposit FAILED. There is nothing for the app
            // to claim in that case, but leaving the tab parked on a success
            // page it can never act on is strictly worse: this way the app is
            // woken, finds no token, and says so.
            if (appRedirect) {
                if (!deposited) {
                    log.error(`[OAuth/${provider}] Native handoff with no token to claim`);
                }
                return res.redirect(appRedirect);
            }

            const html = `<!DOCTYPE html><html><head><title>Login Complete</title></head><body>
<script>
  try {
    if (window.opener) {
      window.opener.postMessage({ type: 'beeflow-oauth-complete' }, '*');
    }
  } catch(e) {}
  window.close();
</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Login complete. You can close this window.</p>
</body></html>`;
            return res.send(html);
        }

        res.redirect(returnTo);
    })();
}

// Shared with loginRoutes and the admin gate — this was a verbatim copy that
// read `allowed_features` alone, i.e. only the plan-grant half of entitlement,
// so an org entitled via its licence tier failed it and `zk` silently wrote
// plaintext. See stores/encryptionAvailability.js for the full note.
const { isSsoPinRequiredForUser } = require('../../stores/encryptionAvailability');

/**
 * Clamp a provider-supplied error to something safe to put in a URL.
 *
 * OAuth error codes are a small ASCII vocabulary (`access_denied`,
 * `invalid_scope`, …). Anything else is a provider misbehaving or somebody
 * hand-crafting a callback, and it must not be reflected into a redirect —
 * least of all now that the redirect may be a native scheme any app on the
 * device can register a handler for.
 */
function safeErrorCode(value) {
    const code = String(value || '').slice(0, 64);
    return /^[A-Za-z0-9_.-]+$/.test(code) ? code : 'oauth_error';
}

// Provider-specific callback
router.get('/callback/:provider', async (req, res) => {
    const { provider } = req.params;

    const { code, error, error_description, state } = req.query;
    const config = await loadConfig();

    log.info(`[OAuth/${provider}] Callback received — session present: ${!!req.sessionID}`);
    log.info(`[OAuth/${provider}] Callback session: oauthPopup=${!!req.session.oauthPopup} oauthPickupId=${req.session.oauthPickupId || '(none)'} oauthState=${req.session.oauthState ? '(present)' : '(missing)'}`);
    log.info(`[OAuth/${provider}] Query params — code present: ${!!code}, error: ${error || 'none'}, state present: ${!!state}`);
    if (error_description) log.info(`[OAuth/${provider}] Error description: ${error_description}`);
    log.info(`[OAuth/${provider}] Session returnTo: ${req.session.returnTo || '(not set)'}`);
    log.info(`[OAuth/${provider}] Session oauthProvider: ${req.session.oauthProvider || '(not set)'}`);

    // A native client's error exits must end at the app, not at a web page the
    // Custom Tab would sit on forever while the app waits out its claim window
    // saying nothing. The error exits below append `?error=<code>`; the app
    // ignores the detail — it learns what happened from whether a token
    // appears — but the link still closes the tab and wakes it.
    // Both come from the session /login filled: the app redirect from its
    // allow-list, returnTo from CLIENT_PUBLIC_HOST or the Referer origin.
    // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect
    const returnTo = req.session.oauthAppRedirect
        || req.session.returnTo
        || 'http://localhost:5173';
    delete req.session.returnTo;

    if (error) {
        log.error(`[OAuth/${provider}] ERROR from provider: ${error} — ${error_description || 'no description'}`);
        return res.redirect(`${returnTo}?error=` + encodeURIComponent(safeErrorCode(error)));
    }

    if (!code) {
        log.error(`[OAuth/${provider}] No authorization code received`);
        return res.redirect(`${returnTo}?error=no_code`);
    }

    // One-shot: clear the stored state before comparing so a leaked state can
    // never be replayed, and reject unless BOTH sides are present — an absent
    // session state must never "match" an absent query state.
    const expectedOauthState = req.session.oauthState;
    delete req.session.oauthState;

    if (req.session.oauthProvider !== provider || !oauthStatesMatch(state, expectedOauthState)) {
        log.error(`[OAuth/${provider}] STATE MISMATCH — stored present: ${!!expectedOauthState}, received present: ${!!state}`);
        return res.redirect(`${returnTo}?error=invalid_state`);
    }

    // Construct REDIRECT_URI the same way as the login handler
    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || 'https';
    if (!host) {
        const forwardedHost = req.get('X-Forwarded-Host');
        if (forwardedHost) {
            host = forwardedHost;
        } else {
            host = req.get('host');
            protocol = req.protocol;
        }
    }
    const REDIRECT_URI = `${protocol}://${host}/auth/callback/${provider}`;

    // PKCE verifier paired with the auth code by /login/:provider. One-shot:
    // clear from the session whether the exchange succeeds or fails so a
    // leaked auth code can't be replayed in another browser.
    const nonce = req.session.oauthNonce;
    delete req.session.oauthNonce;
    const codeVerifier = req.session.oauthCodeVerifier;
    delete req.session.oauthCodeVerifier;

    try {
        let tokenData, user;

        if (provider === 'google') {
            const providerConfig = config.providers?.google || {};

            const googleBody = {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: providerConfig.clientId,
                client_secret: providerConfig.clientSecret,
            };
            if (codeVerifier) googleBody.code_verifier = codeVerifier;
            const tokenResponse = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(googleBody).toString()
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                log.error('Google token exchange failed:', errorText);
                return res.redirect(`${returnTo}?error=token_exchange_failed`);
            }

            tokenData = /** @type {OAuthTokenResponse} */ (await tokenResponse.json());

            const userResponse = await fetch(OAUTH_PROVIDERS.google.userInfoUrl, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });

            if (userResponse.ok) {
                const userData = /** @type {Record<string, any>} */ (await userResponse.json()); // the provider's profile payload
                user = /** @type {OAuthUser} */ ({
                    id: userData.sub || userData.email,
                    displayName: userData.name || userData.email,
                    firstName: userData.given_name || '',
                    lastName: userData.family_name || '',
                    email: userData.email,
                    picture: userData.picture,
                    provider: 'google'
                });
            }

        } else if (provider === 'microsoft') {
            const providerConfig = config.providers?.microsoft || {};
            const tenantId = providerConfig.tenantId || 'common';
            const tokenUrl = OAUTH_PROVIDERS.microsoft.tokenUrl(tenantId);

            log.info(`[OAuth/Microsoft] Token URL: ${tokenUrl}`);
            log.info(`[OAuth/Microsoft] REDIRECT_URI: ${REDIRECT_URI}`);
            log.info(`[OAuth/Microsoft] clientId: ${providerConfig.clientId}`);
            log.info(`[OAuth/Microsoft] clientSecret present: ${!!providerConfig.clientSecret}`);
            log.info(`[OAuth/Microsoft] tenantId: ${tenantId}`);

            const msBody = {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: providerConfig.clientId,
                client_secret: providerConfig.clientSecret,
            };
            if (codeVerifier) msBody.code_verifier = codeVerifier;
            const tokenResponse = await fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(msBody).toString()
            });

            log.info(`[OAuth/Microsoft] Token response status: ${tokenResponse.status} ${tokenResponse.statusText}`);

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                log.error(`[OAuth/Microsoft] TOKEN EXCHANGE FAILED (${tokenResponse.status}):`, errorText);
                return res.redirect(`${returnTo}?error=token_exchange_failed`);
            }

            tokenData = /** @type {OAuthTokenResponse} */ (await tokenResponse.json());
            const { verifyMicrosoftIdentity, assertGraphIdentity } = require('../microsoftIdentity');
            const identity = await verifyMicrosoftIdentity(tokenData.id_token, { clientId: providerConfig.clientId, tenantId, nonce });
            log.info(`[OAuth/Microsoft] Token exchange successful — access_token present: ${!!tokenData.access_token}, refresh_token present: ${!!tokenData.refresh_token}`);
            if (tokenData.scope) log.info(`[OAuth/Microsoft] Granted scopes: ${tokenData.scope}`);
            if (tokenData.error) log.error(`[OAuth/Microsoft] Token response error: ${tokenData.error} — ${tokenData.error_description || ''}`);

            log.info(`[OAuth/Microsoft] User info URL: ${OAUTH_PROVIDERS.microsoft.userInfoUrl}`);
            const userResponse = await fetch(OAUTH_PROVIDERS.microsoft.userInfoUrl, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });

            log.info(`[OAuth/Microsoft] User info response status: ${userResponse.status} ${userResponse.statusText}`);

            if (userResponse.ok) {
                const userData = /** @type {Record<string, any>} */ (await userResponse.json()); // the provider's profile payload
                log.info(`[OAuth/Microsoft] User info received — id: ${userData.id}, displayName: ${userData.displayName}, mail: ${userData.mail}, upn: ${userData.userPrincipalName}`);
                assertGraphIdentity(identity, userData.id);
                // Keep the Azure object id separate from the local id. The
                // local id is resolved/minted in the provisioning block below
                // so we do not collide with users already synced from Azure AD.
                user = /** @type {OAuthUser} */ ({
                    ...identity,
                    displayName: userData.displayName || userData.userPrincipalName,
                    email: userData.mail || userData.userPrincipalName,
                    provider: 'microsoft'
                });
                log.info(`[OAuth/Microsoft] Mapped user — azureUserId: ${user.azureUserId}, displayName: ${user.displayName}, email: ${user.email}`);

                user.picture = await microsoftLogin.saveMicrosoftPhoto(tokenData.access_token, user) || user.picture;
            } else {
                const userErrorText = await userResponse.text();
                log.error(`[OAuth/Microsoft] USER INFO FETCH FAILED (${userResponse.status}):`, userErrorText);
            }
        } else if (provider === 'nextcloud') {
            const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

            const tokenResponse = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: REDIRECT_URI,
                    client_id: clientId,
                    client_secret: clientSecret
                }).toString()
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                log.error('Nextcloud token exchange failed:', errorText);
                return res.redirect(`${returnTo}?error=token_exchange_failed`);
            }

            tokenData = /** @type {OAuthTokenResponse} */ (await tokenResponse.json());

            const userResponse = await fetch(`${nextcloudUrl}/ocs/v2.php/cloud/user?format=json`, {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`,
                    'OCS-APIRequest': 'true'
                }
            });

            if (userResponse.ok) {
                const userData = /** @type {Record<string, any>} */ (await userResponse.json()); // the provider's profile payload
                const ocs = userData.ocs?.data || {};
                // Persist the raw uid for WebDAV path construction. Must be
                // captured BEFORE we mint the prefixed local id below.
                if (ocs.id) req.session.nextcloudUid = ocs.id;
                if (tokenData.expires_in) {
                    req.session.nextcloudTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
                }
                user = /** @type {OAuthUser} */ ({
                    id: `nextcloud-${ocs.id || ocs['display-name']}`,
                    displayName: ocs['display-name'] || ocs.id,
                    email: ocs.email || '',
                    provider: 'nextcloud'
                });
            }
        } else {
            return res.redirect(`${returnTo}?error=unknown_provider`);
        }

        if (!user) {
            log.error(`[OAuth/${provider}] FAILED: Could not obtain user info from provider`);
            return res.redirect(`${returnTo}?error=failed_to_get_user_info`);
        }

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
            return res.redirect(`${returnTo}?error=sso_link_required`);
        }

        // Set when this callback is completing a signup started in the wizard
        // (req.session.pendingSignup). Read further down to keep a personal
        // account out of the org domain-matching and no-organisation gate.
        let signupIntent = null;

        if (existingUser) {
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
        } else {
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
                    return res.redirect(`${returnTo}?error=${reason}`);
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
                        return res.redirect(`${returnTo}?error=${e.oauthCode}`);
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
                            log.error(`[OAuth/${provider}] sso_id_collision — id=${localId} email=${user.email} collides with existing email=${existing.email || 'unknown'}; aborting login`);
                        } else {
                            log.error('[OAuth] auto-provision failed:', r.reason, r.error || '');
                        }
                        return res.redirect(`${returnTo}?error=signup_failed`);
                    }
                }
            } catch (e) {
                if (e instanceof userStore.SeatCapExceededError) {
                    return res.redirect(`${returnTo}?error=seat_cap_exceeded`);
                }
                throw e;
            }
            if (!createOk) {
                return res.redirect(`${returnTo}?error=signup_failed`);
            }
            log.info(`[OAuth/${provider}] Created new user via branch=create → ${localId} (azureUserId=${user.azureUserId || 'none'}, org=${placement.organizationId || 'none'}, status=${placement.status})`);

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

        // Check if user belongs to any organisation.
        //
        // Membership is the union documented in auth/orgMembership.js:
        // users.organizationId ∪ { g.organizationId | g ∈ user.groups }. Use
        // that shared helper rather than re-deriving it — the hand-rolled copy
        // that used to sit here read `g.organization_id`, but the groups table
        // column is quoted camelCase "organizationId" (userStore.js:106) and
        // getAllGroups spreads the row verbatim, so the group path never
        // matched. Group-only members (blank users.organizationId — the shape
        // azureGroupSync produces) therefore looked org-less and got
        // domain-matched into whichever org owns their email domain, or were
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
        // it into one, and never show it the "No Organisation Found" gate. This
        // used to be achieved by returning early from the consumer signup branch.
        const isPersonalAccount = signupIntent?.accountType === 'consumer';

        // If user has no org, try domain-matching
        let pendingApproval = false;
        if (!userHasOrg && !isPersonalAccount && (provider === 'microsoft' || (user.email && user.email.includes('@')))) {
            const matchingOrg = provider === 'microsoft'
                ? await microsoftLogin.trustedMicrosoftOrg(user, msTenant, userStore)
                : resolveOrgByEmailDomain(user.email, await userStore.getAllOrganizations(), await getEffectiveFreeEmailDomains());

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

        // ── Azure group sync on login ──────────────────────────────
        // Fire-and-forget: update Azure group memberships for Microsoft SSO users.
        // Never awaited so it cannot block or fail login.
        if (provider === 'microsoft' && freshUser?.azureUserId && !isLoginBlockedAccount(freshUser)) {
            syncUserGroupsOnLogin(freshUser.id, freshUser.azureUserId, undefined, freshUser.azureTenantId)
                .catch(() => {}); // errors already logged inside the function
        }

        log.info(`[OAuth/${provider}] Session setup — user: ${user.id} (${user.displayName}), pendingApproval: ${pendingApproval}, userHasOrg: ${userHasOrg}`);
        // The account-status gate. SSO had none: suspending someone stopped
        // their password login and left their Microsoft/Google sign-in working,
        // which is the failure mode that matters most — SSO is how most people
        // in an org actually get in. Refused before any session field is
        // written. See auth/accountStatusGate.js.
        if (isLoginBlockedAccount(freshUser)) {
            log.warn(`[OAuth/${provider}] Refused sign-in for a blocked account`);
            return res.status(REFUSAL.status).json(REFUSAL.body);
        }

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

        _respondOAuthLogin(req, res, provider, returnTo, user.id);

    } catch (err) {
        log.error(`[OAuth/${provider}] CALLBACK EXCEPTION:`, err.message);
        log.error(`[OAuth/${provider}] Stack:`, err.stack);
        // The message, not the exception's text: `err.message` can carry
        // internals, and this now also travels to a native scheme any app on
        // the device may claim. The log above keeps the detail.
        res.redirect(`${returnTo}?error=callback_failed`);
    }
});

module.exports = router;
