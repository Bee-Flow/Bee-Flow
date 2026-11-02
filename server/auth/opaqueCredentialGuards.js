// @typecheck strict
/**
 * The credential rules of the OPAQUE routes (./opaqueRoutes.js): who may set
 * a credential, what a replaced one ends, and whether password sign-in is on.
 */

const log = require('../telemetry/log');
const { loadConfig } = require('./permissions');
const { requireRecentAuth } = require('./recentAuth');
const sessionCache = require('./sessionCache');

/**
 * A credential is set from an interactive sign-in of this account only: never
 * over a connector session or a bridge token, and always with a recent proof
 * (the sign-in, a second factor, an OPAQUE exchange — auth/recentAuth.js). The
 * legacy migration and the signup both run right after a sign-in, so they
 * carry one. False when the refusal has been answered.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} userId
 */
function requireCredentialProof(req, res, userId) {
    if (req.session.connectorOrgId || req.headers['x-session-token']) {
        log.warn(`[OPAQUE] Refused credential registration for ${userId} over a connector or bridge session`);
        res.status(403).json({ error: 'Sign in directly to set a password.', code: 'interactive_session_required' });
        return false;
    }
    return requireRecentAuth(req, res, `the credential of ${userId}`);
}

/**
 * A replaced credential ends every other session and bridge token of the
 * account, as a password change does.
 * @param {import('express').Request} req
 * @param {string} userId
 */
async function endOtherSessions(req, userId) {
    try {
        // keepSid is a session id; its default (null) is all the JSDoc of sessionCache.js says.
        const bust = /** @type {(id: string, opts: { keepSid?: string | null }) => Promise<number>} */ (sessionCache.bustSessionsForUser);
        await bust(userId, { keepSid: req.sessionID });
    } catch (err) { require('../utils/bestEffort').bestEffort('opaque:register-end-sessions', err); }
}

/**
 * ALLOW_PASSWORD_LOGIN=false turns password sign-in off for everyone but the
 * operator account, here as on /auth/admin-login.
 * @param {string} username the submitted identifier
 * @param {{ id?: string } | null | undefined} user the account it resolved to
 */
async function passwordLoginAllowed(username, user) {
    if (process.env.ALLOW_PASSWORD_LOGIN !== 'false') return true;
    const adminName = (await loadConfig())?.admin?.username;
    return !!adminName && (username === adminName || user?.id === adminName);
}

module.exports = { requireCredentialProof, endOtherSessions, passwordLoginAllowed };
