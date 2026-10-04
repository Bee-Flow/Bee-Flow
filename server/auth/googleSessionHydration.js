// @typecheck
/**
 * Google session hydration from the automation-credential vault (BFSF-255).
 *
 * Historically, Google Workspace tools only worked when the LIVE SESSION was
 * created by Google-SSO login (session.accessToken/oauthProvider set in the
 * OAuth callback). Password-account users who connect Google via the
 * Settings → Connections tile store their tokens in the encrypted
 * automation_credentials vault instead — this helper copies an active vault
 * credential into the session on demand so every session-based Google surface
 * (chat tool building, /api/integrations/{gmail,gdrive,calendar,contacts,keep}
 * pickers) lights up for them too.
 *
 * Rules:
 *  - NEVER mixes providers: a session that already carries an OAuth identity
 *    (Google/Microsoft/Nextcloud SSO) is left untouched — the tool executors
 *    receive a single session and must not run Gmail calls with a Microsoft
 *    token.
 *  - Hydrated sessions are tagged `oauthTokenSource: 'connector'` so the auth
 *    layer can distinguish them from real SSO logins (the forced-MFA gate for
 *    password accounts must NOT be silently bypassed by connecting Google).
 *  - getProviderAuth refreshes stale tokens and flips the credential to
 *    needs_reauth on refresh failure (pausing automations + notifying) — after
 *    that it returns null quickly, so this helper stays cheap on the hot path.
 */
const log = require('../telemetry/log');

async function hydrateGoogleSessionFromVault(session) {
    const userId = session?.user?.id;
    if (!session || !userId) return false;
    // An existing OAuth identity (SSO login or a previous hydration) wins.
    if (session.oauthProvider) return false;

    try {
        const { getProviderAuth } = require('./automationAuth');
        const cred = await getProviderAuth(userId, 'google');
        if (!cred?.accessToken) return false;

        session.accessToken = cred.accessToken;
        session.refreshToken = cred.refreshToken || null;
        session.oauthProvider = 'google';
        session.oauthTokenSource = 'connector';
        // Persist so subsequent requests skip the vault read; non-fatal.
        if (typeof session.save === 'function') {
            await new Promise((resolve) => session.save(() => resolve()));
        }
        return true;
    } catch (e) {
        log.warn(`[GoogleConnector] session hydration failed for user ${userId}: ${e.message}`);
        return false;
    }
}

// Express middleware wrapper — mounted in front of the session-based Google
// integration routers so their /status and API handlers see a hydrated
// session without each route learning about the vault.
function googleSessionHydration(req, _res, next) {
    hydrateGoogleSessionFromVault(req.session)
        .catch(() => false)
        .finally(() => next());
}

module.exports = { hydrateGoogleSessionFromVault, googleSessionHydration };
