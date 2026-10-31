// @typecheck strict
/**
 * The second factor, shared by every first factor.
 *
 * A password login and an OPAQUE login both park the verified first factor in
 * `session.mfaPending` and answer `{ mfaRequired, mfaMethods }`; the TOTP route
 * (mfaLoginRoutes.js) and the security-key route (securityKeys/loginRoutes.js)
 * then finish whichever one is pending. What a finished login looks like
 * differs per first factor — the password path derives the DEK from the
 * password, the OPAQUE path was handed it by the client — so the branch lives
 * HERE, once, and the second-factor routes do not have to know.
 */

const log = require('../../telemetry/log');
const { finalizeLogin } = require('./finalizeLogin');
const { finalizeOpaqueLogin } = require('./finalizeOpaqueLogin');

/**
 * How long a parked first factor waits for its second. Five minutes is a
 * person typing a code or touching a key; what waits in the session is the
 * derived key, and a tab left on the code screen should not keep it there
 * for the life of a cookie.
 */
const PENDING_MFA_TTL_MS = 5 * 60 * 1000;

/**
 * Park a verified first factor for the second: the blob the two second-factor
 * routes read, stamped so it expires, with the cookie shortened to match so
 * an abandoned attempt is gone from the store as soon as it is gone from use.
 * Session establishment after the second factor regenerates the session and
 * the cookie gets its full lifetime back.
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} pending
 */
function parkPendingLogin(req, pending) {
    req.session.mfaPending = { ...pending, pendingAt: Date.now() };
    if (req.session.cookie) req.session.cookie.maxAge = PENDING_MFA_TTL_MS;
}

/**
 * @param {{ pendingAt?: unknown } | null | undefined} pending
 * @param {number} [now]
 */
function isPendingLoginExpired(pending, now = Date.now()) {
    if (!pending) return true;
    // A blob from before the stamp existed is honoured as it was.
    if (typeof pending.pendingAt !== 'number') return false;
    return now - pending.pendingAt > PENDING_MFA_TTL_MS;
}

/** What the second-factor routes answer for a parked login that waited too long. */
const PENDING_EXPIRED = Object.freeze({
    status: 401,
    body: Object.freeze({ error: 'That took too long. Sign in again with your password.', code: 'pending_login_expired' }),
});

/**
 * Which second factors a pending login may offer: an authenticator app,
 * security keys (auth/securityKeys/), or both. Recovery codes always work and
 * are not listed. Whether a key works on THIS host is settled when the client
 * asks /mfa/security-key/options.
 * @param {{ listSecurityKeys(userId: string): Promise<unknown[]> }} userStore
 * @param {{ id: string, mfa_secret?: string | null }} row
 */
async function mfaMethodsFor(userStore, row) {
    /** @type {string[]} */
    const methods = [];
    if (row.mfa_secret) methods.push('totp');
    if ((await userStore.listSecurityKeys(row.id)).length > 0) methods.push('security_key');
    return methods;
}

/**
 * Finish the login held in `pending` now that the second factor passed. The
 * pending blob is spent first, so a retry can only answer "no pending login".
 *
 * `mfaVerifiedAt` goes on the new session: the step-up checks that let a
 * signed-in session replace its own credential read it (auth/recentAuth.js).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ pending: Record<string, any>, userRow: Record<string, any>, startedAt: number }} args
 */
async function completePendingLogin(req, res, { pending, userRow, startedAt }) {
    delete req.session.mfaPending;
    const sessionExtra = { mfaVerifiedAt: Date.now() };
    if (pending.opaque) {
        return finalizeOpaqueLogin(req, res, {
            user: userRow,
            encryptionKey: pending.encryptionKey ?? null,
            sessionExtra,
        });
    }
    const { user, isAdmin, password, derived } = pending;
    return finalizeLogin(req, res, { user, isAdmin, storedUser: userRow, password, derived, startedAt, sessionExtra });
}

/**
 * What follows a passed OPAQUE proof: the same gate as the password path
 * (login/passwordLoginRoutes.js) — hold the session back, park what the
 * second step needs, ask for the code — or, with no second factor on the
 * account, the session itself. The client already holds the OPAQUE session
 * key from the protocol, so it is not repeated on the parked answer.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ user: { id: string } & Record<string, any>, encryptionKey: string | null, sessionKey: string, userStore: { listSecurityKeys(userId: string): Promise<unknown[]> } }} args
 */
async function settleOpaqueFirstFactor(req, res, { user, encryptionKey, sessionKey, userStore }) {
    if (user.mfa_enabled) {
        const sessionUser = {
            id: user.id, displayName: user.displayName, role: user.role || 'user',
            avatar: user.avatar || null, avatarType: user.avatarType || null,
        };
        parkPendingLogin(req, {
            userId: user.id, isAdmin: user.role === 'admin', user: sessionUser,
            opaque: true, ...(encryptionKey !== null ? { encryptionKey } : {}),
        });
        const mfaMethods = await mfaMethodsFor(userStore, user);
        return req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ mfaRequired: true, mfaMethods });
        });
    }
    // H11: rotate the session id on establishment (session fixation).
    return finalizeOpaqueLogin(req, res, {
        user, encryptionKey,
        sessionExtra: { opaqueLoginAt: Date.now() },
        response: { sessionKey }, // Client needs this for encrypting DEK to send back
    });
}

module.exports = { mfaMethodsFor, completePendingLogin, parkPendingLogin, isPendingLoginExpired, settleOpaqueFirstFactor, PENDING_MFA_TTL_MS, PENDING_EXPIRED };
