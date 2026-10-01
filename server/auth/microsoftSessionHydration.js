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

/**
 * A Microsoft-only session for Graph calls, next to whatever the caller's
 * session already is.
 *
 * hydrateMicrosoftSessionFromVault above never mixes providers, so a user who
 * logs in with Google SSO (or Nextcloud) and connects Microsoft 365 through
 * Settings → Connections kept a session whose tokens are Google's, and every
 * Outlook surface reported "not connected". Instead of overwriting that
 * session, Outlook callers ask for this shim:
 *
 *  - a session that already IS Microsoft comes back unchanged (SSO path);
 *  - a routine session from buildUserAuth carries the Microsoft credential
 *    under `routineProviders.microsoft` when Microsoft is not the primary;
 *  - otherwise the user's vault credential is read (and refreshed when close
 *    to expiry) through getProviderAuth.
 *
 * The shim holds ONLY the Microsoft tokens. msGraphClient refreshes on a 401
 * by writing the new tokens onto the object it was given and calling
 * `save()`: on the shim that lands in the vault, never on
 * `session.accessToken` of the caller's (Google) session.
 *
 * @param {any} session - the caller's session (Express or routine shim)
 * @param {string|null} [userId] - who the credential belongs to; defaults to
 *   the session's user
 * @returns {Promise<any|null>} a session-shaped object, or null when the user
 *   has no working Microsoft credential
 */
async function resolveMicrosoftSession(session, userId = null) {
    if (session?.oauthProvider === 'microsoft' && session?.accessToken) return session;

    const ownerId = userId || session?.user?.id || session?.userId || null;
    let cred = session?.routineProviders?.microsoft || null;
    if (!cred?.accessToken) {
        if (!ownerId) return null;
        try {
            const { getProviderAuth } = require('./routineAuth');
            cred = await getProviderAuth(ownerId, 'microsoft');
        } catch (e) {
            log.warn(`[MicrosoftConnector] vault lookup failed for user ${ownerId}: ${e.message}`);
            return null;
        }
    }
    if (!cred?.accessToken) return null;
    return buildMicrosoftShim(cred, { userId: cred.userId || ownerId, user: session?.user || null });
}

/**
 * The shim itself. `save` writes refreshed tokens back to the vault (and to
 * the credential object it came from, so a routine session's
 * `routineProviders.microsoft` stays current for the next call in the run).
 * expiresAt is cleared on write: msGraphClient does not report the new
 * lifetime, and a null expiry only means the next getProviderAuth refreshes
 * once more, which is safe.
 */
function buildMicrosoftShim(cred, { userId, user }) {
    const shim = {
        user: user || undefined,
        userId,
        oauthProvider: 'microsoft',
        oauthTokenSource: 'connector',
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken || null,
        oauthScope: cred.scope || undefined,
        /** @param {Function} [done] */
        save(done) {
            cred.accessToken = shim.accessToken;
            cred.refreshToken = shim.refreshToken;
            const orgId = cred.orgId;
            const finish = () => { if (typeof done === 'function') done(); };
            if (!userId || !orgId) { finish(); return Promise.resolve(); }
            const routineCredentialStore = require('../stores/routineCredentialStore');
            return Promise.resolve()
                .then(() => routineCredentialStore.upsertCredential({
                    userId,
                    orgId,
                    provider: 'microsoft',
                    accessToken: shim.accessToken,
                    refreshToken: shim.refreshToken,
                    expiresAt: null,
                    scope: shim.oauthScope || cred.scope || null,
                }))
                .catch((e) => log.warn(`[MicrosoftConnector] could not store refreshed token for user ${userId}: ${e.message}`))
                .finally(finish);
        },
    };
    return shim;
}

/** Express middleware wrapper — mount in front of session-based Outlook routers. */
function microsoftSessionHydration(req, _res, next) {
    hydrateMicrosoftSessionFromVault(req.session)
        .catch(() => false)
        .finally(() => next());
}

module.exports = { hydrateMicrosoftSessionFromVault, microsoftSessionHydration, resolveMicrosoftSession };
