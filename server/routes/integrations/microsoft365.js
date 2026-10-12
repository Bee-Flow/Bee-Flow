/**
 * Microsoft 365 connector routes — mounted at /api/integrations/microsoft.
 *
 * The counterpart of routes/integrations/googleWorkspace.js, and it closes three
 * concrete gaps that made Outlook a second-class integration:
 *
 *  1. Microsoft tokens ONLY ever existed as a by-product of Microsoft-SSO login
 *     (core/integrationTools.js gates outlook_* on session.oauthProvider ===
 *     'microsoft'). A password or Google-SSO user could never use Outlook, and
 *     had nowhere to go when a viewer-scoped connector answered 409
 *     connection_required with provider:'outlook'.
 *
 *  2. The SSO callback skips the vault write for users without an
 *     organizationId (auth/oauthRoutes.js), so those accounts had no durable
 *     credential at all — their connectors died with the session. Google solved
 *     that with a per-user vault scope; this does the same.
 *
 *  3. Shared mailboxes need Mail.Read.Shared / Mail.Send.Shared. Adding those to
 *     the SSO scope list would force re-consent on EVERY Microsoft user at
 *     login, and would block login outright in tenants that require admin
 *     consent. A dedicated connect flow asks only the users who opt in.
 *
 *   GET  /auth-url    — start OAuth (state + PKCE)
 *   GET  /callback    — token exchange → encrypted vault (automation_credentials)
 *   GET  /status      — { configured, connected, email, needsReauth, sharedMailboxGranted }
 *   POST /disconnect  — vault delete + session clear
 *
 * Note on disconnect: Microsoft has no token-revocation endpoint, so a
 * disconnect is LOCAL only. The user must remove the app at
 * https://myaccount.microsoft.com to revoke consent at the provider.
 *
 * NO zod schema on any of the four. /callback is the only one that reads
 * input at all, and its query is MICROSOFT's — `code`, `state`, `error`,
 * `error_description` — sent by a browser REDIRECT, so a refusal has to stay
 * the self-closing HTML page this route already answers with, not a JSON
 * 400. The gate that matters there is the state comparison plus the PKCE
 * verifier, not a shape. The other three read nothing but the session.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();
const configStore = require('../../stores/configStore');
const automationCredentialStore = require('../../stores/automationCredentialStore');
const { OAUTH_PROVIDERS, MICROSOFT_SCOPES, loadConfig, requireAuth } = require('../../auth/permissions');

/**
 * The login scopes plus delegated shared-mailbox access.
 *
 * Mail.ReadWrite is deliberately NOT requested: the shared send layer defaults
 * to Graph's single-call `reply`, which only needs Mail.Send(.Shared). Asking
 * for write access to the whole mailbox to send one reply is the kind of
 * over-broad consent that gets an app blocked by tenant policy.
 */
const MS_CONNECT_SCOPES = Object.freeze([
    ...MICROSOFT_SCOPES,
    'Mail.Read.Shared',
    'Mail.Send.Shared',
]);

// Scopes that must be present before a shared mailbox can work at all.
const SHARED_MAILBOX_SCOPES = ['Mail.Read.Shared', 'Mail.Send.Shared'];

async function getMicrosoftClientConfig() {
    const config = await loadConfig();
    const providerConfig = config.providers?.microsoft || {};
    return {
        clientId: providerConfig.clientId || '',
        clientSecret: providerConfig.clientSecret || '',
        tenantId: providerConfig.tenantId || 'common',
    };
}

function buildRedirectUri(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}/api/integrations/microsoft/callback`;
}

// Org members use their org key; org-less accounts get a per-user scope so the
// connection outlives the session (upsertCredential needs a non-empty orgId for
// key derivation). Same rule as the Google connector.
function resolveVaultOrgId(user) {
    return user?.organizationId || `user:${user?.id}`;
}

function statesMatch(received, expected) {
    if (typeof received !== 'string' || typeof expected !== 'string') return false;
    if (!received || !expected || received.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/** Did the grant actually include the shared-mailbox scopes? */
function hasSharedMailboxScopes(scope) {
    const granted = String(scope || '').toLowerCase();
    if (!granted) return false;
    return SHARED_MAILBOX_SCOPES.every((s) => granted.includes(s.toLowerCase()));
}

// ─── Generate OAuth URL ──────────────────────────────────────────
router.get('/auth-url', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { clientId, tenantId } = await getMicrosoftClientConfig();
    if (!clientId) {
        return res.status(400).json({
            error: 'Microsoft 365 is not configured. Ask your admin to set the Microsoft Client ID and Secret.',
            code: 'microsoft_not_configured',
        });
    }

    const redirectUri = buildRedirectUri(req);
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    req.session.microsoftConnectState = state;
    req.session.microsoftConnectVerifier = codeVerifier;
    req.session.microsoftConnectRedirectUri = redirectUri;
    req.session.save?.();

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MS_CONNECT_SCOPES.join(' '),
        state,
        // Force the consent screen so the wider shared-mailbox scopes are
        // actually presented to a user who already consented to the
        // narrower login set.
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    res.json({ url: `${OAUTH_PROVIDERS.microsoft.authUrl(tenantId)}?${params}` });
});

// ─── OAuth Callback ──────────────────────────────────────────────
router.get('/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;
    const userId = req.session?.user?.id;

    const expectedState = req.session.microsoftConnectState;
    const codeVerifier = req.session.microsoftConnectVerifier || '';
    const storedRedirectUri = req.session.microsoftConnectRedirectUri;
    const clearOAuthState = () => {
        delete req.session.microsoftConnectState;
        delete req.session.microsoftConnectVerifier;
        delete req.session.microsoftConnectRedirectUri;
        req.session.save?.();
    };

    if (error) {
        log.error('[MicrosoftConnector] OAuth error:', error, errorDescription || '');
        clearOAuthState();
        // AADSTS65001 = the tenant requires an administrator to consent. Saying
        // "try again" there sends the user in a loop they cannot break.
        const needsAdmin = /AADSTS65001|consent_required|admin_consent/i.test(String(errorDescription || error));
        return res.send(callbackHTML(
            needsAdmin
                ? 'Your Microsoft administrator must approve this app before you can connect.'
                : 'Microsoft authorization was denied.',
            false,
        ));
    }
    if (!userId) return res.send(callbackHTML('Not authenticated. Please log in first.', false));
    if (!statesMatch(state, expectedState)) {
        clearOAuthState();
        return res.send(callbackHTML('Invalid state parameter. Please try again.', false));
    }
    clearOAuthState();

    try {
        const { clientId, clientSecret, tenantId } = await getMicrosoftClientConfig();
        const redirectUri = storedRedirectUri || buildRedirectUri(req);

        const tokenRes = await fetch(OAUTH_PROVIDERS.microsoft.tokenUrl(tenantId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                client_secret: clientSecret,
                code_verifier: codeVerifier,
                scope: MS_CONNECT_SCOPES.join(' '),
            }),
        });
        if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            if (/AADSTS65001/i.test(errText)) {
                log.error('[MicrosoftConnector] admin consent required');
                return res.send(callbackHTML('Your Microsoft administrator must approve this app before you can connect.', false));
            }
            throw new Error(`Token exchange failed: ${tokenRes.status} ${errText.slice(0, 300)}`);
        }
        const tokenData = await tokenRes.json();
        if (!tokenData.refresh_token) {
            // Without offline_access there is no unattended refresh, so the
            // connection would silently die within the hour.
            throw new Error('Microsoft did not return a refresh token (offline_access scope required).');
        }

        let email = '';
        try {
            const infoRes = await fetch(`${OAUTH_PROVIDERS.microsoft.userInfoUrl}?$select=mail,userPrincipalName`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (infoRes.ok) {
                const info = await infoRes.json();
                email = String(info.mail || info.userPrincipalName || '').toLowerCase();
            }
        } catch (_) { /* non-fatal — status just shows no email */ }

        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(userId).catch(() => null);
        const orgId = resolveVaultOrgId({ ...user, id: userId });
        await automationCredentialStore.upsertCredential({
            userId,
            orgId,
            provider: 'microsoft',
            accessToken: tokenData.access_token || null,
            refreshToken: tokenData.refresh_token || null,
            expiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : null,
            // The granted scope drives microsoftRefreshScope, so a refresh keeps
            // the shared-mailbox grant instead of narrowing back to login scopes.
            scope: tokenData.scope || MS_CONNECT_SCOPES.join(' '),
        });
        await configStore.setConfig(`microsoft365_email_user_${userId}`, email);

        try {
            const coworkStore = require('../../stores/coworkStore');
            const resumed = await coworkStore.resumeNeedsReauthForUser(userId);
            if (resumed > 0) log.info(`[MicrosoftConnector] resumed ${resumed} automation(s) for user ${userId}`);
        } catch (e) {
            log.warn(`[MicrosoftConnector] resume-automations failed: ${e.message}`);
        }

        try {
            const integrationConnectionStore = require('../../stores/integrationConnectionStore');
            await integrationConnectionStore.upsertOAuthConnection({
                ownerUserId: userId,
                orgId: user?.organizationId || null,
                provider: 'microsoft',
                label: email || 'Default',
                secretMeta: { source: 'connector', email: email || null, scope: tokenData.scope || null },
            });
        } catch (e) {
            log.warn(`[MicrosoftConnector] connection metadata row skipped: ${e.message}`);
        }

        // Hydrate the live session so tools light up without a re-login — but
        // never clobber an existing OAuth identity (Google/Nextcloud SSO).
        if (!req.session.oauthProvider) {
            req.session.accessToken = tokenData.access_token;
            req.session.refreshToken = tokenData.refresh_token || null;
            req.session.oauthProvider = 'microsoft';
            req.session.oauthTokenSource = 'connector';
            req.session.oauthScope = tokenData.scope || MS_CONNECT_SCOPES.join(' ');
        }

        log.info(`[MicrosoftConnector] Connected for user ${userId}${email ? ` (${email})` : ''}`);
        res.send(callbackHTML(email ? `Connected as ${email}!` : 'Microsoft 365 connected!', true));
    } catch (err) {
        log.error('[MicrosoftConnector] Token exchange error:', err.message);
        res.send(callbackHTML('Microsoft connection failed. Please try again.', false));
    }
});

// ─── Connection Status ───────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { clientId, clientSecret } = await getMicrosoftClientConfig();
    const configured = !!(clientId && clientSecret);

    const cred = await automationCredentialStore.getCredential(userId, 'microsoft').catch(() => null);
    // Microsoft-SSO users without an org have no vault row but ARE connected
    // for this session.
    const sessionConnected = req.session?.oauthProvider === 'microsoft' && !!req.session?.accessToken;
    const connected = cred?.status === 'active' || sessionConnected;
    const needsReauth = !connected && cred?.status === 'needs_reauth';

    // Drives the "connect a shared mailbox" affordance: an SSO-only grant
    // can read /me but will 403 on /users/{address}.
    const sharedMailboxGranted = hasSharedMailboxScopes(cred?.scope || req.session?.oauthScope);

    let email = await configStore.getConfig(`microsoft365_email_user_${userId}`).catch(() => null);
    if (!email && sessionConnected) email = req.session.user?.email || null;

    res.json({
        configured,
        connected,
        needsReauth,
        sharedMailboxGranted,
        email: connected || needsReauth ? email : null,
        // Connected only through the Microsoft login, no vault row: the
        // tile then hides Disconnect, which would clear the SSO tokens from
        // this session and break every Microsoft app until the next login.
        viaSso: sessionConnected && cred?.status !== 'active',
    });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { revokeProviderCredential } = require('../../auth/oauthRoutes');
    const result = await revokeProviderCredential(userId, 'microsoft');

    await configStore.deleteConfig(`microsoft365_email_user_${userId}`).catch(() => {});

    if (req.session.oauthProvider === 'microsoft') {
        delete req.session.accessToken;
        delete req.session.refreshToken;
        delete req.session.oauthProvider;
        delete req.session.oauthTokenSource;
        delete req.session.oauthScope;
        req.session.save?.();
    }

    log.info(`[MicrosoftConnector] Disconnected for user ${userId}`);
    res.json({
        success: true,
        hadCredential: result.found,
        // Microsoft exposes no revocation endpoint, so be honest about it
        // rather than implying the grant is gone at the provider.
        providerRevokeSupported: false,
        revokeHint: 'Remove Bee Flow at https://myaccount.microsoft.com/ to revoke access at Microsoft.',
    });
});

// ─── Callback HTML (self-closing popup) ──────────────────────────
function openerTargetOrigin() {
    const host = process.env.CLIENT_PUBLIC_HOST;
    if (!host) return '*';
    return /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
}

// The message can carry the account's address as Graph returned it; it is
// text, never markup.
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function callbackHTML(message, success) {
    return `<!DOCTYPE html>
<html><head><title>Microsoft 365</title>
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
  <h2>${escapeHtml(message)}</h2>
  <p>${success ? 'You can close this window.' : 'Please close this window and try again.'}</p>
</div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'microsoft-callback', success: ${success} }, ${JSON.stringify(openerTargetOrigin())}); } catch(e) {}
    setTimeout(() => window.close(), 1500);
  }
</script>
</body></html>`;
}

module.exports = router;
module.exports.MS_CONNECT_SCOPES = MS_CONNECT_SCOPES;
module.exports.hasSharedMailboxScopes = hasSharedMailboxScopes;
