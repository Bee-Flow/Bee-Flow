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

const { finalizeLogin } = require('./finalizeLogin');
const { finalizeOpaqueLogin } = require('./finalizeOpaqueLogin');

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
    const { user, isAdmin, password } = pending;
    return finalizeLogin(req, res, { user, isAdmin, storedUser: userRow, password, startedAt, sessionExtra });
}

module.exports = { mfaMethodsFor, completePendingLogin };
