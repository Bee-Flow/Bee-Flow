// @typecheck
/**
 * Self-service OAuth credential management — list and revoke the long-lived
 * provider credentials the automation vault holds for the signed-in user.
 *
 * No request schema: neither route reads a body or a query. `:provider` stays
 * free text on purpose — the vault holds whatever providers the connectors
 * wrote (google, microsoft, nextcloud, withings, …), and an enum here would
 * make the next one unrevocable from this route.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const automationCredentialStore = require('../../stores/automationCredentialStore');

// === Self-service OAuth credential management ===
//
// Lets a signed-in user inspect and revoke the long-lived OAuth credentials
// the automation vault holds on their behalf. Revoking deletes the local row
// AND calls the provider's revocation endpoint when one is known — so
// background runners stop using the credential immediately, and Google /
// Microsoft can clean up their issued tokens. Failures on the provider
// side are logged but the local delete proceeds regardless (we'd rather
// orphan a token in the provider than keep an unrevocable secret around).

function _requireAuthedUser(req, res) {
    if (!req.session?.user?.id) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    return req.session.user.id;
}

router.get('/integrations/credentials', async (req, res) => {
    const userId = _requireAuthedUser(req, res);
    if (!userId) return;
    const list = await automationCredentialStore.listProvidersForUser(userId);
    res.json({ credentials: list });
});

/**
 * The token to hand the provider's revocation endpoint.
 *
 * For Google that is the REFRESH token when the vault has one: revoking it
 * ends the whole grant, and it is the one that stays valid. The vault's access
 * token lives an hour and is only refreshed when an automation runs, so it is
 * usually expired by the time somebody disconnects — and Google answers an
 * expired access token with `invalid_token` and revokes nothing, leaving the
 * grant (and the refresh token) live on the account after "disconnect".
 */
function _revocableToken(provider, cred) {
    if (provider === 'google') return cred.refreshToken || cred.accessToken || null;
    return cred.accessToken || null;
}

// Best-effort provider-side revocation. Each provider expects a slightly
// different shape; failures are non-fatal so the local delete always
// proceeds. Tokens are decrypted from the vault only inside this call.
async function _revokeAtProvider(provider, token) {
    if (!token) return { ok: false, reason: 'no_token' };
    try {
        if (provider === 'google') {
            const r = await fetch('https://oauth2.googleapis.com/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token }).toString(),
            });
            return { ok: r.ok, status: r.status };
        }
        if (provider === 'microsoft') {
            // Microsoft Graph doesn't expose a token-revoke endpoint for
            // confidential clients. The closest official action is calling
            // /me/revokeSignInSessions, but that requires the right scope.
            // Document and skip — local delete still cuts off our access.
            return { ok: false, reason: 'no_revoke_endpoint' };
        }
        if (provider === 'nextcloud') {
            // Per-instance; we don't know the instance URL from inside this
            // helper, and the Nextcloud OAuth2 app doesn't standardise a
            // revocation endpoint. Skip.
            return { ok: false, reason: 'no_revoke_endpoint' };
        }
        return { ok: false, reason: 'unknown_provider' };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

/**
 * Revoke a user's stored provider credential: best-effort provider-side
 * revoke, then mark-revoked + delete in the vault, then audit. Shared by the
 * DELETE route below and the Google Workspace connector's disconnect
 * (routes/integrations/googleWorkspace.js — BFSF-255).
 * Returns { found, deleted, providerRevokeAttempted, providerRevokeOk }.
 */
async function revokeProviderCredential(userId, provider) {
    const cred = await automationCredentialStore.getCredential(userId, provider);
    if (!cred) return { found: false };

    // 1. Provider-side revoke (best-effort).
    const revokeToken = _revocableToken(provider, cred);
    const providerResult = await _revokeAtProvider(provider, revokeToken);
    if (!providerResult.ok) {
        log.warn(`[OAuth] provider revoke userId=${userId} provider=${provider} skipped: ${providerResult.reason || providerResult.status}`);
    }

    // 2. Mark revoked first (so a partial failure leaves the row in a
    // refusable state), then delete.
    await automationCredentialStore.markRevoked(userId, provider).catch(() => {});
    const deleted = await automationCredentialStore.deleteCredential(userId, provider);

    // 3. Audit. Uses the access_audit_log added in C7 — same shape as
    // credential.delete from configStore.
    try {
        const userStore = require('../../stores/userStore');
        await userStore.logAccessAudit(
            'credential.revoke',
            'oauth_credential',
            `${userId}:${provider}`,
            userId,
            null,
            { provider, provider_revoke_ok: providerResult.ok },
            cred.orgId || null,
        );
    } catch (_) { /* non-fatal */ }

    return { found: true, deleted, providerRevokeAttempted: !!revokeToken, providerRevokeOk: providerResult.ok };
}

router.delete('/integrations/credentials/:provider', async (req, res) => {
    const userId = _requireAuthedUser(req, res);
    if (!userId) return;
    const provider = String(req.params.provider || '').toLowerCase();
    const result = await revokeProviderCredential(userId, provider);
    if (!result.found) return res.status(404).json({ error: 'Credential not found' });
    res.json({ success: result.deleted, providerRevokeAttempted: result.providerRevokeAttempted, providerRevokeOk: result.providerRevokeOk });
});

module.exports = router;
module.exports.revokeProviderCredential = revokeProviderCredential;
