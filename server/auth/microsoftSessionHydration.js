// @typecheck
/**
 * Microsoft session hydration from the routine-credential vault.
 *
 * The counterpart of auth/googleSessionHydration.js. Outlook surfaces read
 * tokens straight off the live session (routes/integrations/outlook.js) and
 * core/integrationTools.js gates the outlook_* tools on
 * `session.oauthProvider === 'microsoft'` — so before this, a user who
 * connected Microsoft through Settings → Connections still saw "not connected"
 * everywhere until they logged out and back in via Microsoft SSO.
 *
 * Rules are identical to the Google helper, and the first one is load-bearing:
 *  - NEVER mixes providers. A session already carrying an OAuth identity is left
 *    alone; tool executors get one session and must not run Graph calls with a
 *    Google token.
 *  - Hydrated sessions are tagged `oauthTokenSource: 'connector'` so the auth
 *    layer can tell them apart from a real SSO login (connecting a mailbox must
 *    not quietly satisfy a forced-MFA gate).
 *  - The granted scope travels along, so a later refresh re-requests what was
 *    actually consented instead of narrowing the grant.
 */
const log = require('../telemetry/log');

async function hydrateMicrosoftSessionFromVault(session) {
    const userId = session?.user?.id;
    if (!session || !userId) return false;
    if (session.oauthProvider) return false;

    try {
        const { getProviderAuth } = require('./routineAuth');
        const cred = await getProviderAuth(userId, 'microsoft');
        if (!cred?.accessToken) return false;

        session.accessToken = cred.accessToken;
        session.refreshToken = cred.refreshToken || null;
        session.oauthProvider = 'microsoft';
        session.oauthTokenSource = 'connector';
        if (cred.scope) session.oauthScope = cred.scope;
        if (typeof session.save === 'function') {
            await new Promise((resolve) => session.save(() => resolve()));
        }
        return true;
    } catch (e) {
        log.warn(`[MicrosoftConnector] session hydration failed for user ${userId}: ${e.message}`);
        return false;
    }
}

/** Express middleware wrapper — mount in front of session-based Outlook routers. */
function microsoftSessionHydration(req, _res, next) {
    hydrateMicrosoftSessionFromVault(req.session)
        .catch(() => false)
        .finally(() => next());
}

module.exports = { hydrateMicrosoftSessionFromVault, microsoftSessionHydration };
