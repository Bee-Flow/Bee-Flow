// @typecheck strict
/**
 * NMBRS REST connector routes — mounted at /api/integrations/nmbrs.
 *
 *   GET  /auth-url    — start OAuth (state + PKCE S256), for the signed-in user's own Nmbrs app
 *   GET  /callback    — code exchange → encrypted vault (automation_credentials, provider `nmbrs`)
 *   GET  /status      — { mode, configured, hasSubscriptionKey, hasClient, connected, needsReauth, redirectUri, soapSunset }
 *   POST /disconnect  — revoke at Nmbrs (refresh + access token), then vault delete + audit
 *
 * Modelled on routes/integrations/withings.js and microsoft365.js. The OAuth facts
 * (endpoints, Basic client auth, PKCE, rotation of the refresh token) and their
 * sources are in integrations/nmbrsOAuth.mts.
 *
 * NO zod schema on any of the four: /callback reads only Nmbrs' redirect query
 * (`code`, `state`, `error`), answered with a self-closing page, never JSON; the
 * gate that matters there is the state check: single use, bound to the signed-in
 * user and at most ten minutes old. The other three read nothing but the session.
 * No `:id` parameter: a user only ever reaches their own connection.
 *
 * Secrets never leave the server: the client secret is read from configStore for
 * the back-channel token call only, tokens go straight into the vault, and no
 * response or log line carries any of them.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { bodyOf } = require('../../core/http/schemaParts');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { fallback } = require('../../utils/bestEffort');
const oauth = require('../../integrations/nmbrsOAuth.mts');
const { clearNmbrsPageCacheForUser } = require('../../integrations/nmbrsPageCacheBinding');

/**
 * Stores, lazily, so tests inject them (configStore comes from oauth.oauthDeps).
 * @type {{ vault: () => Pick<typeof import('../../stores/automationCredentialStore'), 'getCredential' | 'upsertCredential'>, getUser: (userId: string) => Promise<{ organizationId?: string | null } | null>, revokeLocal: (userId: string, provider: string) => Promise<{ found: boolean }> }}
 */
const routeDeps = {
    vault: () => require('../../stores/automationCredentialStore'),
    getUser: (userId) => require('../../stores/userStore').getUser(userId),
    // Local delete + audit, shared with the other connectors.
    revokeLocal: (userId, provider) => require('../../auth/oauthRoutes').revokeProviderCredential(userId, provider),
};

/** Nmbrs retires the SOAP API on this date (https://nmbrs.stoplight.io/docs/nmbrs-restapi, "Migrating from SOAP?"). */
const SOAP_SUNSET = '2027-03-01';

/** @param {import('express').Request} req */
function buildRedirectUri(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}/api/integrations/nmbrs/callback`;
}

// ─── Start the OAuth flow ────────────────────────────────────────
router.get('/auth-url', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const client = await oauth.clientConfigFor(userId);
    if (!client.clientId || !client.clientSecret || !(await oauth.subscriptionKeyFor(userId))) {
        return res.status(400).json({
            error: 'Save the NMBRS subscription key, client ID and client secret first.',
            code: 'nmbrs_not_configured',
        });
    }
    const attempt = oauth.newConnectAttempt(userId, buildRedirectUri(req));
    req.session.nmbrsConnect = attempt;
    req.session.save?.();
    res.json({ url: oauth.authorizeUrl(client.clientId, attempt), redirectUri: attempt.redirectUri });
});

// ─── OAuth callback (GET — Nmbrs redirects the browser here) ─────
router.get('/callback', async (req, res) => {
    const { code, state, error } = /** @type {{ code?: unknown, state?: unknown, error?: unknown }} */ (req.query);
    const userId = req.session?.user?.id;
    // One-shot: the attempt never survives this request, whatever the outcome.
    const attempt = req.session?.nmbrsConnect;
    if (req.session) {
        delete req.session.nmbrsConnect;
        req.session.save?.();
    }

    if (error) return res.send(callbackHTML('NMBRS authorization was denied.', false));
    if (!userId) return res.send(callbackHTML('Not authenticated. Please log in first.', false));
    if (!oauth.attemptMatches(attempt, state, userId) || typeof code !== 'string' || !code) {
        return res.send(callbackHTML('Invalid or expired request. Please try again.', false));
    }

    try {
        const tokens = await oauth.exchangeCode(await oauth.clientConfigFor(userId), code, attempt);
        if (!tokens.refreshToken) throw new Error('NMBRS issued no refresh token (offline_access missing)');
        const user = await routeDeps.getUser(userId).catch((e) => fallback('routes/integrations/nmbrs:user', e, null));
        await routeDeps.vault().upsertCredential({
            userId,
            // Same encryption scope rule as the other connectors (auth/automationAuth.js vaultOrgIdFor).
            orgId: user?.organizationId || `user:${userId}`,
            provider: oauth.PROVIDER,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            scope: tokens.scope,
        });
        clearNmbrsPageCacheForUser(userId);
        log.info(`[NMBRS] REST connected for user ${userId}`);
        res.send(callbackHTML('NMBRS connected!', true));
    } catch (err) {
        log.warn(`[NMBRS] REST connect failed for user ${userId}: ${/** @type {Error} */ (err).message}`);
        res.send(callbackHTML('NMBRS connection failed. Please try again.', false));
    }
});

// ─── Status ──────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const client = await oauth.clientConfigFor(userId);
    const cred = await routeDeps.vault().getCredential(userId, oauth.PROVIDER).catch((e) => fallback('routes/integrations/nmbrs:status', e, null));
    const mode = (await oauth.oauthDeps.configStore().getSecret(`nmbrs_api_mode_user_${userId}`)) === 'rest' ? 'rest' : 'soap';
    const hasSubscriptionKey = !!(await oauth.subscriptionKeyFor(userId));
    const hasClient = !!(client.clientId && client.clientSecret);
    res.json({
        mode,
        configured: hasSubscriptionKey && hasClient,
        hasSubscriptionKey,
        hasClient,
        connected: cred?.status === 'active',
        needsReauth: cred?.status === 'needs_reauth',
        // The address to register as redirect URI in the Nmbrs developer portal.
        redirectUri: buildRedirectUri(req),
        soapSunset: SOAP_SUNSET,
    });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', requireAuth, validate({ body: bodyOf({}, 'Disconnecting Nmbrs') }), async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const cred = await routeDeps.vault().getCredential(userId, oauth.PROVIDER).catch((e) => fallback('routes/integrations/nmbrs:disconnect', e, null));
    let revoked = false;
    if (cred) revoked = await oauth.revokeAtNmbrs(await oauth.clientConfigFor(userId), cred);
    const result = await routeDeps.revokeLocal(userId, oauth.PROVIDER);
    clearNmbrsPageCacheForUser(userId);
    log.info(`[NMBRS] REST disconnected for user ${userId} (revoked at NMBRS: ${revoked})`);
    res.json({ success: true, hadCredential: result.found, revokedAtNmbrs: revoked });
});

// ─── Callback page (self-closing popup) ──────────────────────────
function openerTargetOrigin() {
    const host = process.env.CLIENT_PUBLIC_HOST;
    if (!host) return '*';
    return /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `https://${host}`;
}

/** @param {string} message @param {boolean} success */
function callbackHTML(message, success) {
    return `<!DOCTYPE html><html><head><title>NMBRS</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center"><h2>${message}</h2><p>${success ? 'You can close this window.' : 'Please close this window and try again.'}</p></div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'nmbrs-callback', success: ${success} }, ${JSON.stringify(openerTargetOrigin())}); } catch (e) { console.debug('opener gone', e); }
    setTimeout(() => window.close(), 1500);
  }
</script></body></html>`;
}

module.exports = Object.assign(router, { routeDeps });
