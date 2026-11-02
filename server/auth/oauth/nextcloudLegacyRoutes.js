// @typecheck strict
/**
 * Legacy Nextcloud OAuth — /login and /callback, the pre-multi-provider URIs
 * that Nextcloud OAuth clients configured before /callback/:provider existed
 * still point at.
 *
 * NO REQUEST SCHEMA HERE, on purpose. The query string on a callback is
 * written by the identity provider, not by us: Google, Microsoft and Nextcloud
 * each add their own parameters (`authuser`, `hd`, `prompt`, `session_state`,
 * `scope`, …) and add more without asking. A `.strict()` query would turn a
 * provider's next release into "sign-in is broken", and the fields that decide
 * anything — `state` against the session, `code` through the token exchange —
 * are already checked where they are used, which is the check that matters.
 *
 * GET /login here is an entry point rather than a callback, but it is left
 * open for the sibling reason in providerLoginRoutes.js: it is navigated to,
 * not fetched, so a 400 is a dead-end page instead of an error a client can
 * show. The same popup rule applies as there, and is written down there:
 * `?popup=true` is not popup mode, only `?popup=1` is.
 *
 * GET /login handles two things the way its modern sibling does:
 *
 *   - The popup and pickup flags: setting them when asked and never clearing
 *     them is wrong, because the callback clears them only after a SUCCESSFUL
 *     popup sign-in. An attempt abandoned in the embedded popup would leave
 *     both on the session, and the next ordinary sign-in in that browser would inherit them: the
 *     intermediate popup page, the "you can close this window" page with no
 *     opener, and a live session token parked under the old pickup id. Each
 *     attempt starts from none of them (see providerLoginRoutes.js).
 *   - The return address: taking it from the Referer alone would send the
 *     person back to THAT site after a link from any site to /auth/login
 *     (and on `oauth_not_configured`). It asks shared.getReturnUrl, which puts
 *     the configured CLIENT_PUBLIC_HOST first, so an install that names its client host
 *     returns there, and one that does not behaves as before.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();

const { loadConfig } = require('../permissions');
const { establishSession } = require('../establishSession');
const { isLoginBlockedAccount, REFUSAL } = require('../accountStatusGate');
const userStore = require('../../stores/userStore');
const { resolveSsoUser } = require('./ssoUserProvisioning');
const { resolveOrgStanding, writeOAuthSession } = require('./ssoSessionSetup');
const { getReturnUrl, oauthStatesMatch, popupRedirect } = require('./shared');
const { isPickupTokenShaped } = require('../../utils/sessionToken');

// Legacy Nextcloud login redirect
router.get('/login', async (req, res) => {
    const config = await loadConfig();
    const { nextcloudUrl, clientId } = config.oauth || {};

    // The configured client host first, the Referer only without one — the
    // same resolver as /login/:provider (see the header).
    const returnTo = getReturnUrl(req);
    req.session.returnTo = returnTo;

    // This attempt's mode comes from this request alone. Left over from an
    // abandoned popup attempt, these steer the callback of an ordinary
    // sign-in (see the header). The app handoff is cleared with them: this
    // flow never sets it, and the next /login/:provider must not find it.
    delete req.session.oauthPopup;
    delete req.session.oauthPickupId;
    delete req.session.oauthPickupChallenge;
    delete req.session.oauthAppRedirect;

    // Mirror the new /login/:provider route's iframe support so that BeeFlow
    // installs whose Nextcloud OAuth client still points at the legacy
    // /auth/callback URI keep working in embedded mode.
    if (req.query.popup === '1') req.session.oauthPopup = true;
    // A pickup needs a well-formed challenge; the claim must answer it with
    // the secret (utils/sessionToken.js).
    if (req.query.pickup && isPickupTokenShaped(req.query.pickup_challenge)) {
        req.session.oauthPickupId = String(req.query.pickup).slice(0, 128);
        req.session.oauthPickupChallenge = req.query.pickup_challenge;
    }

    const host = req.get('host');
    const REDIRECT_URI = `${req.protocol}://${host}/auth/callback`;

    if (!nextcloudUrl || !clientId) {
        return res.redirect(`${returnTo}?error=oauth_not_configured`);
    }

    // CSRF defense — the state must be high-entropy and validated on callback.
    // `Math.random()` was both predictable and unread on the callback side.
    const state = crypto.randomBytes(16).toString('hex');
    req.session.legacyOAuthState = state;

    const authUrl = `${nextcloudUrl}/apps/oauth2/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        state,
    }).toString();

    req.session.save(() => {
        if (req.session.oauthPopup) return popupRedirect(res, authUrl);
        res.redirect(authUrl);
    });
});

// Legacy Nextcloud callback
router.get('/callback', async (req, res) => {
    const { code, error, state } = /** @type {Record<string, string>} */ (req.query);
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = config.oauth || {};

    // returnTo was set by /login from CLIENT_PUBLIC_HOST, or from the Referer
    // origin when no client host is configured (nextcloudLegacyRoutes.test.js).
    // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect
    const returnTo = req.session.returnTo || 'http://localhost:5173';
    delete req.session.returnTo;

    log.info(`[OAuth/legacy] CALLBACK session: oauthPopup=${!!req.session.oauthPopup} oauthPickupId=${req.session.oauthPickupId ? '(present)' : '(none)'}`);

    const host = req.get('host');
    const REDIRECT_URI = `${req.protocol}://${host}/auth/callback`;

    // Validate the CSRF state we issued at /login above. Compare in
    // constant time and clear the session value either way so a leaked
    // state can't be replayed.
    const expectedState = req.session.legacyOAuthState;
    delete req.session.legacyOAuthState;
    if (!oauthStatesMatch(state, expectedState)) {
        return res.redirect(`${returnTo}?error=invalid_state`);
    }

    if (error) {
        log.error('OAuth error:', error);
        return res.redirect(`${returnTo}?error=` + encodeURIComponent(error));
    }

    if (!code) {
        return res.redirect(`${returnTo}?error=no_code`);
    }

    try {
        const tokenResponse = await fetch(`${nextcloudUrl}/apps/oauth2/api/v1/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
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
            log.error('Token exchange failed:', errorText);
            return res.redirect(`${returnTo}?error=token_exchange_failed`);
        }

        const tokenData = /** @type {{ access_token?: string, refresh_token?: string, expires_in?: number|string, [key: string]: any }} */ (await tokenResponse.json());

        const userResponse = await fetch(`${nextcloudUrl}/ocs/v2.php/cloud/user?format=json`, {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'OCS-APIRequest': 'true'
            }
        });

        /** @type {{ id: string, [key: string]: any } | null} */
        let ncUser = null;
        if (userResponse.ok) {
            const userData = /** @type {{ ocs?: { data?: { id: string, [key: string]: any } } }} */ (await userResponse.json());
            ncUser = userData.ocs?.data || null;
            // Persist the raw Nextcloud uid for WebDAV path construction.
            if (ncUser?.id) req.session.nextcloudUid = ncUser.id;
        }
        if (!ncUser?.id) return res.redirect(`${returnTo}?error=failed_to_get_user_info`);
        if (tokenData.expires_in) {
            req.session.nextcloudTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
        }

        // The same account resolution, status gate and session fields as
        // /callback/nextcloud: the account is found by (nextcloud, uid), the
        // provider-prefixed id and the e-mail rules of resolveSsoUser. An
        // account this callback created under the raw uid is found only with
        // the same e-mail and no SSO identity recorded yet, never by the raw
        // uid alone (ssoUserResolver.js); the uid is then recorded.
        /** @type {import('./providerCallbackRoutes').OAuthUser} */
        const user = ({
            id: `nextcloud-${ncUser.id}`,
            displayName: ncUser['display-name'] || ncUser.id,
            email: ncUser.email || '',
            provider: 'nextcloud',
            subject: String(ncUser.id),
            emailVerified: false,
            ncBaseUrl: nextcloudUrl || null,
            legacyRawUid: String(ncUser.id),
        });
        const resolved = await resolveSsoUser({ req, provider: 'nextcloud', user, config });
        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- resolved.error is one of resolveSsoUser's fixed codes; returnTo comes from the session
        if (resolved.error) return res.redirect(`${returnTo}?error=${resolved.error}${resolved.error === 'sso_link_required' ? '&hint=link_from_settings' : ''}`);
        const { freshUser, userHasOrg, pendingApproval, isPersonalAccount } = await resolveOrgStanding({
            provider: 'nextcloud', user, signupIntent: resolved.signupIntent,
        });

        // The account-status gate — read BEFORE the session fields are written,
        // for the same reason as the other three paths. See
        // auth/accountStatusGate.js.
        if (isLoginBlockedAccount(freshUser)) {
            log.warn('[OAuth/nextcloud-legacy] Refused sign-in for a blocked account');
            return res.status(REFUSAL.status).json(REFUSAL.body);
        }
        await writeOAuthSession({ req, provider: 'nextcloud', user, freshUser, tokenData: /** @type {import('./providerCallbackRoutes').OAuthTokenResponse} */ (tokenData), pendingApproval, userHasOrg, isPersonalAccount });

        // H11: rotate the session id at the moment of authentication. The
        // pre-auth token material (nextcloudUid / accessToken / refreshToken /
        // oauthProvider / nextcloudTokenExpiresAt) and the popup/pickup keys
        // were written on the old session and are read after this point —
        // they must survive the rotation or the iframe pickup dead-ends.
        (async () => {
            try {
                await establishSession(req, {
                    user: req.session.user,
                    isAdmin: req.session.isAdmin || false,
                    preserve: [
                        'oauthPopup', 'oauthPickupId', 'oauthPickupChallenge',
                        'accessToken', 'refreshToken', 'oauthProvider',
                        'nextcloudUid', 'nextcloudTokenExpiresAt',
                        'encryptionKey', 'needsEncryptionSetup', 'needsEncryptionPin',
                        'pendingApproval', 'noOrganization',
                    ],
                    audit: { method: 'nextcloud_legacy' },
                });
            } catch (err) {
                log.error('Session save error:', err);
            }

            // Embedded-iframe popup handoff (mirrors /callback/:provider).
            if (req.session.oauthPopup) {
                const pickupId = req.session.oauthPickupId;
                const pickupChallenge = req.session.oauthPickupChallenge;
                delete req.session.oauthPopup;
                delete req.session.oauthPickupId;
                delete req.session.oauthPickupChallenge;
                req.session.save();

                if (pickupId) {
                    try {
                        const { setSessionToken, setPickup, generateToken } = require('../../utils/sessionToken');
                        const userIdLegacy = user?.id || 'oauth-user';
                        const appPasswordData = await userStore.getAppPassword(userIdLegacy);
                        const sessionToken = generateToken();
                        await setSessionToken(sessionToken, {
                            user: req.session.user,
                            accessToken: req.session.accessToken,
                            refreshToken: req.session.refreshToken,
                            oauthProvider: req.session.oauthProvider,
                            nextcloudUid: req.session.nextcloudUid,
                            appPassword: appPasswordData,
                            isAuthenticated: true,
                            isAdmin: req.session.isAdmin || false,
                            // The same two gates the modern callback deposits.
                            // Without them a bridged client is told a user
                            // awaiting approval is approved — the bypass was
                            // closed on the other writers and this one was
                            // missed, which is why the tripwire in
                            // utils/sessionToken.test.js now finds its writers
                            // by search instead of listing them.
                            pendingApproval: req.session.pendingApproval || false,
                            noOrganization: req.session.noOrganization || false,
                            authenticatedAt: req.session.authenticatedAt,
                        });
                        await setPickup(pickupId, pickupChallenge ? { sessionToken, challenge: pickupChallenge } : { sessionToken });
                        log.info(`[OAuth/legacy] Pickup deposited (bound: ${!!pickupChallenge})`);
                    } catch (pickupErr) {
                        log.error(`[OAuth/legacy] Pickup deposit failed:`, pickupErr.message);
                    }
                }

                return res.send(`<!DOCTYPE html><html><head><title>Login Complete</title></head><body>
<script>try{if(window.opener)window.opener.postMessage({type:'beeflow-oauth-complete'},'*');}catch (e) { console.debug("opener gone", e); }window.close();</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">Login complete. You can close this window.</p>
</body></html>`);
            }

            res.redirect(returnTo);
        })();

    } catch (err) {
        log.error('OAuth callback error:', err);
        res.redirect(`${returnTo}?error=` + encodeURIComponent(err.message));
    }
});

module.exports = router;
