// @typecheck strict
/**
 * The Google session of the Meet routes and the access gate a manual import
 * passes twice: when the request is accepted, and again when the background
 * job starts.
 */

const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');
const { sessionUser } = require('../http/sessionUser');

/**
 * @param {string} message
 * @param {string} code
 */
function gmeetError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

/**
 * Resolve a Google session for the gmeet routes. The live Google session wins;
 * otherwise an 'active' vault credential (refreshed via getProviderAuth) is
 * wrapped in a session shim. Returns { session, source: 'live'|'vault'|null,
 * cred, connection } — `connection` is the status block the UI renders its
 * connect/reconnect CTAs from, `session` is null without usable Google auth.
 */
/** @param {import('express').Request} req */
async function resolveGmeetSession(req) {
    const userId = sessionUser(req).id;
    const { deriveConnectionStatus } = require('./gmeetNotesSettings');
    let cred = null;
    try {
        const automationCredentialStore = require('../../stores/automationCredentialStore');
        cred = await automationCredentialStore.getCredential(userId, 'google');
    } catch (err) { fallbackSwallowed('routes/transcriptions/gmeet:resolveGmeetSession', err); /* vault unavailable → session-only */ }
    const connection = deriveConnectionStatus({ session: req.session, credential: cred });

    if (req.session.oauthProvider === 'google' && req.session.accessToken) {
        return { session: req.session, source: 'live', cred, connection };
    }
    if (cred && cred.status === 'active') {
        const { getProviderAuth } = require('../../auth/automationAuth');
        const auth = await getProviderAuth(userId, 'google');
        if (auth && auth.accessToken) {
            // Session shim — createGoogleApiClient writes refreshed tokens back
            // into this object; the durable copy lives in the vault, refreshed
            // by getProviderAuth itself on the next resolve.
            return {
                session: { accessToken: auth.accessToken, refreshToken: auth.refreshToken },
                source: 'vault',
                cred: auth,
                connection,
            };
        }
    }
    return { session: null, source: null, cred, connection };
}

/**
 * The Google session + Meet scope gate, shared by the request and the
 * background run (access is checked again when the job actually runs).
 * @param {import('express').Request} req
 */
async function requireMeetAccess(req) {
    const { session, connection } = await resolveGmeetSession(req);
    if (!session) {
        throw gmeetError(
            connection.needsReauth
                ? 'Google access expired — reconnect your Google account'
                : 'Google is not connected for this account',
            connection.needsReauth ? 'needs_reauth' : 'not_connected',
        );
    }
    if (!connection.meetScopesGranted) {
        throw gmeetError('Google Meet access has not been granted — reconnect Google to add the Meet scopes', 'needs_meet_scopes');
    }
    return { session, connection };
}

module.exports = { gmeetError, resolveGmeetSession, requireMeetAccess };
