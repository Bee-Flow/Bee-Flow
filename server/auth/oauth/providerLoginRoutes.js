// @typecheck
/**
 * Multi-provider OAuth login — GET /login/:provider mints the CSRF state and
 * the PKCE pair and builds the authorize URL for Google, Microsoft and
 * Nextcloud.
 *
 * NO REQUEST SCHEMA HERE, on purpose. The browser NAVIGATES to this URL — the
 * marketing site, the SPA and the native clients all build it — so the answer
 * to a bad query is a page, and a 400 from a schema is a dead end with nothing
 * to show the person. The three parameters it reads are already handled where
 * they are used: an unknown `?app=` is logged and ignored rather than trusted,
 * `?pickup=` is capped at 128 characters, and an unknown `:provider` redirects
 * with `error=unknown_provider`.
 *
 * ONE SILENT FALLBACK IS LEFT STANDING, and written down rather than fixed
 * here: popup mode is `req.query.popup === '1'`, so `?popup=true` is not popup
 * mode, and the callback renders a redirect instead of the postMessage the
 * embedded iframe is waiting for — a sign-in that simply never completes.
 * Widening that comparison changes what a URL means, which belongs with
 * whoever owns the embed contract.
 *
 * AN ABSENT PARAMETER MEANS "OFF" FOR THIS ATTEMPT, NOT "AS LAST TIME". The
 * popup, pickup and native-app flags used to be set when asked for and never
 * cleared here, while the callback clears them only after a successful popup
 * login. So an attempt abandoned in the embedded popup — or in the Android
 * Custom Tab, which shares Chrome's cookies — left them on the session, and
 * the next ordinary sign-in from that browser inherited them: it ended on the
 * "you can close this window" page with no opener to close, or was 302'd to
 * the `beeflow://` scheme, and parked a live session token under the old
 * pickup id. Each attempt now starts from none of the three.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();

const { loadConfig, OAUTH_PROVIDERS } = require('../permissions');
const { getReturnUrl, popupRedirect, resolveNativeAppRedirect } = require('./shared');

// === Multi-Provider OAuth Routes ===

// Provider-specific login - redirects to OAuth provider
router.get('/login/:provider', async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    const returnTo = getReturnUrl(req);
    req.session.returnTo = returnTo;
    req.session.oauthProvider = provider;

    // This attempt's mode comes from this request alone. Left over from an
    // abandoned popup or Custom Tab attempt, any of these steers the callback
    // of an ordinary sign-in (see the header).
    delete req.session.oauthPopup;
    delete req.session.oauthPickupId;
    delete req.session.oauthAppRedirect;
    delete req.session.oauthNonce;

    // When ?popup=1 is set (embedded iframe mode), remember so the callback
    // can render a postMessage page instead of a redirect.
    if (req.query.popup === '1') {
        req.session.oauthPopup = true;
    }
    // When ?pickup=<id> is set (storage-partitioned iframe), the iframe is
    // polling /auth/login-pickup?id=<id> for a session token to bridge the
    // cookie gap. Stash the id so the callback can deposit a token.
    if (req.query.pickup) {
        req.session.oauthPickupId = String(req.query.pickup).slice(0, 128);
    }
    // When ?app=<key> names a known native client, the callback 302s to that
    // app's own scheme instead of rendering the close page — which is the only
    // way an Android Custom Tab can be made to close itself. What gets stashed
    // is the RESOLVED literal from shared.js, never anything from the query, so
    // nothing downstream has to re-validate it.
    if (req.query.app) {
        const appRedirect = resolveNativeAppRedirect(String(req.query.app));
        if (appRedirect) {
            req.session.oauthAppRedirect = appRedirect;
        } else {
            // Sanitised before logging: a raw CR/LF in a query value forges a
            // log line. Length alone is enough to debug a typo'd key.
            log.warn(`[OAuth] Ignoring unknown ?app= key (${String(req.query.app).length} chars)`);
        }
    }

    log.info(`[OAuth] Login start (${provider}) — session present: ${!!req.sessionID}`);

    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || 'https';

    if (!host) {
        const forwardedHost = req.get('X-Forwarded-Host');
        const referer = req.get('Referer');

        if (forwardedHost) {
            host = forwardedHost;
            log.info(`[OAuth] Using X-Forwarded-Host: ${host}`);
        } else if (referer) {
            try {
                const refererUrl = new URL(referer);
                host = refererUrl.host;
                protocol = refererUrl.protocol.replace(':', '');
                log.info(`[OAuth] Using Referer origin: ${protocol}://${host}`);
            } catch (e) {
                log.warn('[OAuth] Invalid Referer, using host header');
                host = req.get('host');
                protocol = req.protocol;
            }
        } else {
            host = req.get('host');
            protocol = req.protocol;
        }
    } else {
        log.info(`[OAuth] Using SERVER_PUBLIC_HOST: ${protocol}://${host}`);
    }

    const REDIRECT_URI = `${protocol}://${host}/auth/callback/${provider}`;

    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;

    // PKCE (RFC 7636) — generate a 32-byte verifier and its SHA-256 challenge
    // so the token exchange is bound to this browser even if an attacker
    // intercepts the auth code. Stash the verifier in the session (cleared
    // on callback) and send the challenge with the authorize request. We
    // emit PKCE for every provider that supports it (Google + Microsoft).
    // Nextcloud's OAuth2 app supports PKCE since v22 — sending it is safe;
    // servers that don't recognise the params ignore them.
    const codeVerifier = crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    req.session.oauthCodeVerifier = codeVerifier;

    if (provider === 'google') {
        const providerConfig = config.providers?.google || {};
        if (!providerConfig.clientId) {
            return res.redirect(`${returnTo}?error=google_not_configured`);
        }

        const authUrl = OAUTH_PROVIDERS.google.authUrl + '?' + new URLSearchParams({
            response_type: 'code',
            client_id: providerConfig.clientId,
            redirect_uri: REDIRECT_URI,
            scope: OAUTH_PROVIDERS.google.scopes.join(' '),
            state: state,
            access_type: 'offline',
            prompt: 'consent',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        }).toString();

        req.session.save(() => {
            if (req.session.oauthPopup) return popupRedirect(res, authUrl);
            res.redirect(authUrl);
        });

    } else if (provider === 'microsoft') {
        const providerConfig = config.providers?.microsoft || {};
        log.info(`[OAuth/Microsoft] clientId present: ${!!providerConfig.clientId}, clientSecret present: ${!!providerConfig.clientSecret}`);
        log.info(`[OAuth/Microsoft] tenantId: ${providerConfig.tenantId || 'common (default)'}`);
        log.info(`[OAuth/Microsoft] REDIRECT_URI: ${REDIRECT_URI}`);
        log.info(`[OAuth/Microsoft] returnTo: ${returnTo}`);
        if (!providerConfig.clientId) {
            log.error(`[OAuth/Microsoft] ABORT: No clientId configured`);
            return res.redirect(`${returnTo}?error=microsoft_not_configured`);
        }

        const tenantId = providerConfig.tenantId || 'common';
        const nonce = crypto.randomBytes(32).toString('base64url');
        req.session.oauthNonce = nonce;
        const scopes = OAUTH_PROVIDERS.microsoft.scopes.join(' ');
        log.info(`[OAuth/Microsoft] Scopes: ${scopes}`);
        const authUrl = OAUTH_PROVIDERS.microsoft.authUrl(tenantId) + '?' + new URLSearchParams({
            response_type: 'code',
            client_id: providerConfig.clientId,
            redirect_uri: REDIRECT_URI,
            scope: scopes,
            state: state,
            nonce,
            response_mode: 'query',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        }).toString();

        log.info(`[OAuth/Microsoft] OAuth state saved to session`);
        req.session.save((err) => {
            if (err) log.error(`[OAuth/Microsoft] Session save error on login redirect:`, err);
            if (req.session.oauthPopup) return popupRedirect(res, authUrl);
            res.redirect(authUrl);
        });

    } else if (provider === 'nextcloud') {
        const { nextcloudUrl, clientId } = config.oauth || {};
        if (!nextcloudUrl || !clientId) {
            return res.redirect(`${returnTo}?error=nextcloud_not_configured`);
        }

        const authUrl = `${nextcloudUrl}/apps/oauth2/authorize?` + new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            state: state
        }).toString();

        log.info(`[OAuth] Nextcloud OAuth state saved to session`);
        req.session.save(() => {
            if (req.session.oauthPopup) return popupRedirect(res, authUrl);
            res.redirect(authUrl);
        });
    } else {
        res.redirect(`${returnTo}?error=unknown_provider`);
    }
});

module.exports = router;
