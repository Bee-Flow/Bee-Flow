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
const { bestEffort } = require('../../utils/bestEffort');
const router = express.Router();

const { loadConfig } = require('../permissions');
const { establishSession } = require('../establishSession');
const { isLoginBlockedAccount, REFUSAL } = require('../accountStatusGate');
const userStore = require('../../stores/userStore');
const { syncUserGroupsOnLogin } = require('../../integrations/azureGroupSync');
const { oauthStatesMatch, knownNativeAppRedirect } = require('./shared');
// The callback's three halves: the provider exchange, the account, the session.
const { exchangeCodeForUser } = require('./providerTokenExchange');
const { resolveSsoUser } = require('./ssoUserProvisioning');
const { resolveOrgStanding, writeOAuthSession } = require('./ssoSessionSetup');

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
  } catch (e) { console.debug("opener gone", e); }
  window.close();
</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Login complete. You can close this window.</p>
</body></html>`;
            return res.send(html);
        }

        res.redirect(returnTo);
    })();
}

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

/** The callback URL, built the same way as the login handler builds it. */
function callbackRedirectUri(req, provider) {
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
    return `${protocol}://${host}/auth/callback/${provider}`;
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

    const REDIRECT_URI = callbackRedirectUri(req, provider);

    // PKCE verifier paired with the auth code by /login/:provider. One-shot:
    // clear from the session whether the exchange succeeds or fails so a
    // leaked auth code can't be replayed in another browser.
    const nonce = req.session.oauthNonce;
    delete req.session.oauthNonce;
    const codeVerifier = req.session.oauthCodeVerifier;
    delete req.session.oauthCodeVerifier;

    try {
        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- exchange.error is one of providerTokenExchange's fixed codes and returnTo comes from the session (see above)
        const exchange = await exchangeCodeForUser({
            provider, config, code, redirectUri: REDIRECT_URI, codeVerifier, nonce, session: req.session,
        });
        if (exchange.error) return res.redirect(`${returnTo}?error=${exchange.error}`);
        const { tokenData, user } = exchange;

        if (!user) {
            log.error(`[OAuth/${provider}] FAILED: Could not obtain user info from provider`);
            return res.redirect(`${returnTo}?error=failed_to_get_user_info`);
        }

        const resolved = await resolveSsoUser({ req, provider, user, config });
        if (resolved.error) return res.redirect(`${returnTo}?error=${resolved.error}`);
        const { freshUser, userHasOrg, pendingApproval, isPersonalAccount } = await resolveOrgStanding({
            provider, user, msTenant: resolved.msTenant, signupIntent: resolved.signupIntent,
        });

        // ── Azure group sync on login ──────────────────────────────
        // Fire-and-forget: update Azure group memberships for Microsoft SSO users.
        // Never awaited so it cannot block or fail login.
        if (provider === 'microsoft' && freshUser?.azureUserId && !isLoginBlockedAccount(freshUser)) {
            syncUserGroupsOnLogin(freshUser.id, freshUser.azureUserId, undefined, freshUser.azureTenantId)
                .catch((e) => bestEffort('oauthCallback:azure-group-sync', e));
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

        await writeOAuthSession({ req, provider, user, freshUser, tokenData, pendingApproval, userHasOrg, isPersonalAccount });

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
