/**
 * Withings connector routes — mounted at /api/integrations/withings.
 *
 *   GET  /auth-url    — start OAuth (CSRF state, offline by default)
 *   GET  /callback    — token exchange → encrypted vault (automation_credentials)
 *   GET  /status      — { configured, connected, needsReauth, withingsUserId }
 *   POST /disconnect  — vault delete + audit
 *
 * NO zod schema on any of the four. /callback is the only one that reads
 * input at all, and its query is WITHINGS' — `code`, `state`, `error` — sent
 * by a browser REDIRECT, so a refusal has to stay the self-closing HTML page
 * this route already answers with, not a JSON 400. The gate that matters
 * there is the state comparison, not a shape. The other three read nothing
 * but the session.
 *
 * Modelled on routes/integrations/googleWorkspace.js: a manual connect flow
 * decoupled from authentication. Withings is deliberately NOT wired into
 * /auth/login/:provider — it issues no identity, so it must never be able to
 * create or sign in a Bee Flow user. (permissions.js marks it `ssoLogin:false`
 * and the SSO provider guard 404s on it.)
 *
 * Two Withings deviations from plain OAuth2, both handled below and shared with
 * the vault refresher (auth/automationAuth.js):
 *   • the token endpoint is action-dispatched — `action=requesttoken`;
 *   • a refusal arrives as HTTP 200 with a non-zero `status`, and the tokens
 *     live one level down under `body`.
 *
 * No PKCE: Withings' authorize endpoint does not accept `code_challenge`, and
 * sending one has been observed to fail the exchange rather than be ignored.
 * The CSRF state check plus the confidential-client secret carry the flow.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();
const configStore = require('../../stores/configStore');
const automationCredentialStore = require('../../stores/automationCredentialStore');
const automationAuth = require('../../auth/automationAuth');
const { OAUTH_PROVIDERS, requireAuth } = require('../../auth/permissions');

const PROVIDER = 'withings';
const TOKEN_TIMEOUT_MS = 20000;

function buildRedirectUri(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}/api/integrations/withings/callback`;
}

// Org members encrypt under their org key; org-less consumer accounts get a
// per-user scope so the connection outlives the session (upsertCredential needs
// a non-empty orgId to derive a key). Same rule as the Google connector — the
// two must agree or a user's vault rows would land under two different keys.
function resolveVaultOrgId(user) {
    return user?.organizationId || `user:${user?.id}`;
}

function statesMatch(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    if (!received || !expected || received.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// ─── Generate OAuth URL ──────────────────────────────────────────
router.get('/auth-url', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { clientId } = await automationAuth.withingsClientConfig();
    if (!clientId) {
        return res.status(400).json({
            error: 'Withings is not configured. Ask your admin to set the Withings Client ID and Secret in Admin → Integrations.',
            code: 'withings_not_configured',
        });
    }

    const redirectUri = buildRedirectUri(req);
    const state = crypto.randomBytes(16).toString('hex');
    req.session.withingsConnectState = state;
    req.session.withingsConnectRedirectUri = redirectUri;
    req.session.save?.();

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_PROVIDERS.withings.scopes.join(','),
        state,
    });

    res.json({ url: `${OAUTH_PROVIDERS.withings.authUrl}?${params}` });
});

// ─── OAuth Callback (GET — Withings redirects here) ──────────────
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const userId = req.session?.user?.id;

    // One-shot: the state must not survive this request whatever the outcome,
    // so a failed attempt leaves nothing replayable in the session.
    const expectedState = req.session.withingsConnectState;
    const storedRedirectUri = req.session.withingsConnectRedirectUri;
    const clearOAuthState = () => {
        delete req.session.withingsConnectState;
        delete req.session.withingsConnectRedirectUri;
        req.session.save?.();
    };

    if (error) {
        log.error('[WithingsConnector] OAuth error:', error);
        clearOAuthState();
        return res.send(callbackHTML('Withings authorization was denied.', false));
    }
    if (!userId) {
        return res.send(callbackHTML('Not authenticated. Please log in first.', false));
    }
    if (!statesMatch(state, expectedState)) {
        clearOAuthState();
        return res.send(callbackHTML('Invalid state parameter. Please try again.', false));
    }
    clearOAuthState();

    try {
        const { clientId, clientSecret } = await automationAuth.withingsClientConfig();
        if (!clientId || !clientSecret) throw new Error('Withings OAuth is not configured');
        const redirectUri = storedRedirectUri || buildRedirectUri(req);

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TOKEN_TIMEOUT_MS);
        let tokenRes;
        try {
            tokenRes = await fetch(OAUTH_PROVIDERS.withings.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    action: 'requesttoken',
                    grant_type: 'authorization_code',
                    code: String(code || ''),
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri,
                }).toString(),
                signal: ac.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (!tokenRes.ok) {
            const errText = await tokenRes.text().catch(() => '');
            throw new Error(`Token exchange failed: ${tokenRes.status} ${errText.slice(0, 300)}`);
        }
        const payload = await tokenRes.json().catch(() => null);
        if (!payload) throw new Error('Withings returned a non-JSON token response');
        // Shared unwrapper: status must be 0 and the tokens live under `body`.
        const tokenData = automationAuth.readWithingsBody(payload, 'token exchange');
        if (!tokenData.access_token || !tokenData.refresh_token) {
            throw new Error('Withings token response was missing tokens');
        }

        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(userId).catch(() => null);
        const orgId = resolveVaultOrgId({ ...user, id: userId });
        await automationCredentialStore.upsertCredential({
            userId,
            orgId,
            provider: PROVIDER,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : null,
            scope: tokenData.scope || null,
        });

        // The Withings account id — the only identifier the API returns. Shown
        // in the status card so a user with two Health Mate accounts can tell
        // which one is linked. Not a secret, and never used for authorisation.
        const withingsUserId = tokenData.userid ? String(tokenData.userid) : '';
        await configStore.setConfig(`withings_userid_user_${userId}`, withingsUserId);

        // Resume automations paused while the credential was in needs_reauth.
        try {
            const coworkStore = require('../../stores/coworkStore');
            const resumed = await coworkStore.resumeNeedsReauthForUser(userId);
            if (resumed > 0) log.info(`[WithingsConnector] resumed ${resumed} automation(s) for user ${userId}`);
        } catch (e) {
            log.warn(`[WithingsConnector] resume-automations failed: ${e.message}`);
        }

        // Metadata row in the named-connections layer — upsert, not insert: one
        // Withings account per user, so a reconnect refreshes the existing row.
        try {
            const integrationConnectionStore = require('../../stores/integrationConnectionStore');
            await integrationConnectionStore.upsertOAuthConnection({
                ownerUserId: userId,
                orgId: user?.organizationId || null,
                provider: PROVIDER,
                label: withingsUserId ? `Withings ${withingsUserId}` : 'Default',
                secretMeta: { source: 'connector', withingsUserId: withingsUserId || null, scope: tokenData.scope || null },
            });
        } catch (e) {
            log.warn(`[WithingsConnector] connection metadata row skipped: ${e.message}`);
        }

        // Deliberately NOT hydrating req.session.accessToken: Withings is not an
        // identity, and the session's OAuth slot belongs to the SSO provider.
        log.info(`[WithingsConnector] Connected for user ${userId}`);
        res.send(callbackHTML('Withings connected!', true));
    } catch (err) {
        log.error('[WithingsConnector] Token exchange error:', err.message);
        res.send(callbackHTML('Withings connection failed. Please try again.', false));
    }
});

// ─── Connection Status ───────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { clientId, clientSecret } = await automationAuth.withingsClientConfig();
    const configured = !!(clientId && clientSecret);

    const cred = await automationCredentialStore.getCredential(userId, PROVIDER).catch(() => null);
    const connected = cred?.status === 'active';
    const needsReauth = !connected && cred?.status === 'needs_reauth';
    const withingsUserId = (connected || needsReauth)
        ? await configStore.getConfig(`withings_userid_user_${userId}`).catch(() => null)
        : null;

    res.json({ configured, connected, needsReauth, withingsUserId: withingsUserId || null, scope: cred?.scope || null });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Shared with the generic credentials API so both surfaces behave
    // identically (mark revoked → delete → audit). Withings exposes no
    // token-revocation endpoint, so _revokeAtProvider reports
    // 'unknown_provider' and the local delete is what actually cuts access.
    const { revokeProviderCredential } = require('../../auth/oauthRoutes');
    const result = await revokeProviderCredential(userId, PROVIDER);
    await configStore.deleteConfig(`withings_userid_user_${userId}`).catch(() => {});

    log.info(`[WithingsConnector] Disconnected for user ${userId}`);
    res.json({ success: true, hadCredential: result.found });
});

// ─── Callback HTML (self-closing popup) ──────────────────────────
function openerTargetOrigin() {
    const host = process.env.CLIENT_PUBLIC_HOST;
    if (!host) return '*';
    return /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
}

function callbackHTML(message, success) {
    return `<!DOCTYPE html>
<html><head><title>Withings</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
  .card { text-align: center; padding: 40px; border-radius: 16px; background: #1a1a1a; box-shadow: 0 8px 32px rgba(0,0,0,.3); max-width: 400px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  p { color: #888; font-size: 14px; margin: 0; }
</style>
</head><body>
<div class="card">
  <div class="icon">${success ? '✅' : '❌'}</div>
  <h2>${message}</h2>
  <p>${success ? 'You can close this window.' : 'Please close this window and try again.'}</p>
</div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'withings-callback', success: ${success} }, ${JSON.stringify(openerTargetOrigin())}); } catch(e) {}
    setTimeout(() => window.close(), 1500);
  }
</script>
</body></html>`;
}

module.exports = router;
