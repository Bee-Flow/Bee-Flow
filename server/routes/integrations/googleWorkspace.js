/**
 * Google Workspace connector routes (BFSF-255) — mounted at
 * /api/integrations/google.
 *
 * Before this, Google tokens ONLY existed as a by-product of Google-SSO
 * *login*: email/password users could never use Gmail/Calendar/Drive tools,
 * and even SSO users had no way to see, disconnect, or reconnect their Google
 * authorisation. This is a manual connect flow (modelled on
 * routes/integrations/linkedin.js) that is decoupled from authentication:
 *
 *   GET  /auth-url    — start OAuth (state + PKCE, offline access)
 *   GET  /callback    — token exchange → encrypted vault (automation_credentials)
 *   GET  /status      — { configured, connected, email, needsReauth }
 *   POST /disconnect  — provider-side revoke + vault delete + session clear
 *
 * NO zod schema on any of the four. /callback is the only one that reads
 * input at all, and its query is GOOGLE's — `code`, `state`, `error` — sent
 * by a browser REDIRECT, so a refusal has to stay the self-closing HTML page
 * this route already answers with, not a JSON 400. The gate that matters
 * there is the timing-safe state comparison plus the PKCE verifier, not a
 * shape. The other three read nothing but the session.
 *
 * Tokens land in the same automationCredentialStore vault the SSO login feeds
 * (_vaultUpsertSafe), so automations AND the session-hydration layer
 * (auth/googleSessionHydration.js) work identically for both acquisition
 * paths. The live session is hydrated immediately (tagged
 * oauthTokenSource:'connector') so chat tools light up without a re-login —
 * but ONLY when the session has no OAuth identity yet (never clobbers a
 * Microsoft/Nextcloud SSO session).
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();
const configStore = require('../../stores/configStore');
const automationCredentialStore = require('../../stores/automationCredentialStore');

// Same OAuth client + scope set as SSO login (permissions.js OAUTH_PROVIDERS)
// so a connector consent never conflicts with an SSO consent for the same app.
const { OAUTH_PROVIDERS, loadConfig, requireAuth } = require('../../auth/permissions');

async function getGoogleClientConfig() {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};
    return {
        clientId: providerConfig.clientId || '',
        clientSecret: providerConfig.clientSecret || '',
    };
}

function buildRedirectUri(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}/api/integrations/google/callback`;
}

// Encryption scope for the vault row — the shared rule lives in
// auth/automationAuth.vaultOrgIdFor (org key, else a per-user scope) so every
// writer of automation_credentials derives it identically. Lazily required: the
// route's own test stubs the store this module loads at boot.
function resolveVaultOrgId(user) {
    return require('../../auth/automationAuth').vaultOrgIdFor(user);
}

// Constant-time CSRF-state comparison, matching the legacy SSO callback in
// auth/oauthRoutes.js. Length is checked first because timingSafeEqual throws
// on a length mismatch.
function statesMatch(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    if (!received || !expected || received.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// ─── Generate OAuth URL ──────────────────────────────────────────
// requireAuth (not a bare session check) so a deleted user's session is
// revalidated and destroyed here too. /callback keeps its inline check: it is a
// browser redirect and must answer with HTML, not a JSON 401.
router.get('/auth-url', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { clientId } = await getGoogleClientConfig();
    if (!clientId) {
        return res.status(400).json({ error: 'Google Workspace is not configured. Ask your admin to set the Google Client ID and Secret.', code: 'google_not_configured' });
    }

    const redirectUri = buildRedirectUri(req);

    // CSRF state + PKCE (same construction as the SSO login flow).
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    req.session.googleConnectState = state;
    req.session.googleConnectVerifier = codeVerifier;
    req.session.googleConnectRedirectUri = redirectUri;
    req.session.save?.();

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_PROVIDERS.google.scopes.join(' '),
        state,
        // offline + consent → Google returns a refresh_token, which the
        // vault needs for unattended refresh across sessions.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    res.json({ url: `${OAUTH_PROVIDERS.google.authUrl}?${params}` });
});

// ─── OAuth Callback (GET — Google redirects here) ────────────────
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const userId = req.session?.user?.id;

    // One-shot: the state/verifier pair must not survive this request whatever
    // the outcome. Previously they were only deleted on success, so a failed
    // attempt left a replayable pair in the session for its whole lifetime.
    const expectedState = req.session.googleConnectState;
    const codeVerifier = req.session.googleConnectVerifier || '';
    const storedRedirectUri = req.session.googleConnectRedirectUri;
    const clearOAuthState = () => {
        delete req.session.googleConnectState;
        delete req.session.googleConnectVerifier;
        delete req.session.googleConnectRedirectUri;
        req.session.save?.();
    };

    if (error) {
        log.error('[GoogleConnector] OAuth error:', error);
        clearOAuthState();
        return res.send(callbackHTML('Google authorization was denied.', false));
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
        const { clientId, clientSecret } = await getGoogleClientConfig();
        const redirectUri = storedRedirectUri || buildRedirectUri(req);

        // Exchange code for tokens (PKCE verifier bound to this browser).
        const tokenRes = await fetch(OAUTH_PROVIDERS.google.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                client_secret: clientSecret,
                code_verifier: codeVerifier,
            }),
        });
        if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            throw new Error(`Token exchange failed: ${tokenRes.status} ${errText.slice(0, 300)}`);
        }
        const tokenData = await tokenRes.json();

        // Identify the connected Google account for the status display. Only
        // record a VERIFIED address: an unverified one would be shown as the
        // connected account and used as the connection label, including where
        // the connection is lent to teammates.
        let email = '';
        try {
            const infoRes = await fetch(OAUTH_PROVIDERS.google.userInfoUrl, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (infoRes.ok) {
                const info = await infoRes.json();
                if (info.email_verified !== false) email = info.email || '';
            }
        } catch (_) { /* non-fatal — status just shows no email */ }

        // Persist into the encrypted vault (same home as SSO-acquired tokens).
        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(userId).catch(() => null);
        const orgId = resolveVaultOrgId({ ...user, id: userId });
        await automationCredentialStore.upsertCredential({
            userId,
            orgId,
            provider: 'google',
            accessToken: tokenData.access_token || null,
            refreshToken: tokenData.refresh_token || null,
            expiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : null,
            scope: tokenData.scope || null,
        });
        await configStore.setConfig(`google_workspace_email_user_${userId}`, email);

        // Resume automations and cowork that were paused for needs_reauth.
        try {
            const coworkStore = require('../../stores/coworkStore');
            const resumed = await coworkStore.resumeNeedsReauthForUser(userId);
            if (resumed > 0) log.info(`[GoogleConnector] resumed ${resumed} automation(s) for user ${userId}`);
        } catch (e) {
            log.warn(`[GoogleConnector] resume-automations failed: ${e.message}`);
        }

        // Metadata row in the named-connections layer — without it the
        // connection only appears after the next-restart backfill. Upsert, not
        // insert: one Google identity per user, so a reconnect must refresh the
        // existing row rather than stack another one next to it.
        try {
            const integrationConnectionStore = require('../../stores/integrationConnectionStore');
            await integrationConnectionStore.upsertOAuthConnection({
                ownerUserId: userId,
                orgId: user?.organizationId || null,
                provider: 'google',
                label: email || 'Default',
                secretMeta: { source: 'connector', email: email || null, scope: tokenData.scope || null },
            });
        } catch (e) {
            log.warn(`[GoogleConnector] connection metadata row skipped: ${e.message}`);
        }

        // Hydrate the LIVE session so chat tools work immediately — but never
        // clobber an existing OAuth identity (Microsoft/Nextcloud SSO).
        if (!req.session.oauthProvider) {
            req.session.accessToken = tokenData.access_token;
            req.session.refreshToken = tokenData.refresh_token || null;
            req.session.oauthProvider = 'google';
            req.session.oauthTokenSource = 'connector';
        }

        log.info(`[GoogleConnector] Connected for user ${userId}${email ? ` (${email})` : ''}`);
        res.send(callbackHTML(email ? `Connected as ${email}!` : 'Google Workspace connected!', true));
    } catch (err) {
        log.error('[GoogleConnector] Token exchange error:', err.message);
        res.send(callbackHTML('Google connection failed. Please try again.', false));
    }
});

// ─── Connection Status ───────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { clientId, clientSecret } = await getGoogleClientConfig();
    const configured = !!(clientId && clientSecret);

    const cred = await automationCredentialStore.getCredential(userId, 'google').catch(() => null);
    // Session fallback: Google-SSO consumers without an org have no vault
    // row (historic sessions) but ARE connected for this session.
    const sessionConnected = req.session?.oauthProvider === 'google' && !!req.session?.accessToken;
    const connected = cred?.status === 'active' || sessionConnected;
    const needsReauth = !connected && cred?.status === 'needs_reauth';

    // Meet scope check for Meeting Notes: derived from the stored vault
    // scope — session-only users without a vault row report false so the
    // UI hints a (re)connect that records the granted scopes.
    const { hasMeetScopes } = require('../../core/meetingNotes/gmeetNotesSettings');
    const meetScopesGranted = hasMeetScopes(cred?.scope);

    let email = await configStore.getConfig(`google_workspace_email_user_${userId}`).catch(() => null);
    if (!email && sessionConnected) email = req.session.user?.email || null;

    res.json({ configured, connected, needsReauth, meetScopesGranted, email: connected || needsReauth ? email : null });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Provider revoke + vault delete + audit — shared with the generic
    // credentials API so both surfaces behave identically.
    const { revokeProviderCredential } = require('../../auth/oauthRoutes');
    const result = await revokeProviderCredential(userId, 'google');

    await configStore.deleteConfig(`google_workspace_email_user_${userId}`).catch(() => {});

    // Drop the Google tokens from the live session (SSO users stay signed
    // in — only their Google tool access ends until they reconnect).
    if (req.session.oauthProvider === 'google') {
        delete req.session.accessToken;
        delete req.session.refreshToken;
        delete req.session.oauthProvider;
        delete req.session.oauthTokenSource;
        req.session.save?.();
    }

    log.info(`[GoogleConnector] Disconnected for user ${userId}`);
    res.json({ success: true, hadCredential: result.found });
});

// ─── Callback HTML (self-closing popup, LinkedIn pattern) ────────
// The opener is the app itself, so target the app origin rather than '*'.
// CLIENT_PUBLIC_HOST is the deployed front-end origin; in dev the SPA runs on a
// different port than the API, so fall back to '*' there — the payload carries
// no secret, only { type, success }.
function openerTargetOrigin() {
    const host = process.env.CLIENT_PUBLIC_HOST;
    if (!host) return '*';
    return /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
}

function callbackHTML(message, success) {
    return `<!DOCTYPE html>
<html><head><title>Google Workspace</title>
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
    try { window.opener.postMessage({ type: 'google-callback', success: ${success} }, ${JSON.stringify(openerTargetOrigin())}); } catch(e) {}
    setTimeout(() => window.close(), 1500);
  }
</script>
</body></html>`;
}

module.exports = router;
