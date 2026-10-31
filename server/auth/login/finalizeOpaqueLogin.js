// @typecheck strict
/**
 * The tail of an OPAQUE login: the session, once every factor has passed.
 * Called by /opaque/login/finish directly when the account has no second
 * factor, and by completePendingLogin (pendingMfa.js) after one.
 *
 * Unlike finalizeLogin there is no DEK to derive here: the client unwrapped
 * it with the OPAQUE export key and, when it wants the server to hold it for
 * the session, sent it sealed under the protocol's session key. What arrives
 * is the decrypted value or null.
 */

const log = require('../../telemetry/log');
const { establishSession } = require('../establishSession');
const { isLoginBlockedAccount, REFUSAL } = require('../accountStatusGate');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ user: Record<string, any>, encryptionKey?: string | null, sessionExtra?: Record<string, unknown>, response?: Record<string, unknown> }} args
 */
async function finalizeOpaqueLogin(req, res, { user, encryptionKey = null, sessionExtra = {}, response = {} }) {
    // The account-status gate, asked here as well as at the protocol step:
    // the second-factor completion arrives minutes later with a freshly read
    // row, and an account suspended in between must not get its session.
    if (isLoginBlockedAccount(user)) {
        return res.status(REFUSAL.status).json(REFUSAL.body);
    }
    const sessionUser = {
        id: user.id,
        displayName: user.displayName,
        role: user.role || 'user',
        avatar: user.avatar || null,
        avatarType: user.avatarType || null,
    };
    try {
        // H11: rotate the session id on establishment (session fixation).
        await establishSession(req, {
            user: sessionUser,
            isAdmin: user.role === 'admin',
            extra: {
                opaqueMode: true,
                ...(encryptionKey !== null ? { encryptionKey } : {}),
                ...sessionExtra,
            },
            audit: { method: 'opaque', organizationId: user.organizationId || null },
        });
    } catch (err) {
        log.error('Session save error:', err);
    }
    return res.json({ success: true, user: sessionUser, ...response });
}

module.exports = { finalizeOpaqueLogin };
