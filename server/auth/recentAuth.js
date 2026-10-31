// @typecheck strict
/**
 * "Did this person prove who they are a moment ago?"
 *
 * A signed-in session is enough to USE the account; it is not enough to
 * replace the credential that protects it. Those routes ask for a recent
 * proof: the sign-in itself, a second factor, an OPAQUE password or PIN
 * exchange — whichever happened last, within a short window.
 *
 * The marks are written by establishSession (`authenticatedAt`), the second-
 * factor routes (`mfaVerifiedAt`), finalizeOpaqueLogin (`opaqueLoginAt`) and
 * the PIN unlock (`pinVerifiedAt`). A session rebuilt from a bridge token
 * carries the `authenticatedAt` the token was minted with, so for such a
 * client "recent" means "signed in recently", which is the only proof it has.
 */

const RECENT_AUTH_MAX_AGE_MS = 10 * 60 * 1000;

const MARKS = ['authenticatedAt', 'mfaVerifiedAt', 'opaqueLoginAt', 'pinVerifiedAt'];

/**
 * @param {Record<string, unknown> | null | undefined} session
 * @param {number} [now]
 * @param {number} [maxAgeMs]
 */
function hasRecentAuth(session, now = Date.now(), maxAgeMs = RECENT_AUTH_MAX_AGE_MS) {
    if (!session) return false;
    for (const mark of MARKS) {
        const at = session[mark];
        if (typeof at === 'number' && at <= now && now - at <= maxAgeMs) return true;
    }
    return false;
}

/** The refusal every step-up route answers with. */
const REAUTH_REQUIRED = Object.freeze({
    status: 403,
    body: Object.freeze({
        error: 'Sign in again before changing this.',
        code: 'reauth_required',
    }),
});

/**
 * Answer the refusal when the session holds no recent proof; true when it
 * does and the route may go on.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} what for the log line, e.g. "the credential of u1"
 */
function requireRecentAuth(req, res, what) {
    if (hasRecentAuth(req.session)) return true;
    require('../telemetry/log').warn(`[Auth] Refused to replace ${what} without a recent proof`);
    res.status(REAUTH_REQUIRED.status).json({ ...REAUTH_REQUIRED.body });
    return false;
}

module.exports = { hasRecentAuth, requireRecentAuth, RECENT_AUTH_MAX_AGE_MS, REAUTH_REQUIRED };
