// @typecheck strict
/**
 * The store side of the e-mailed password reset (auth/login/passwordResetRoutes.js).
 */

const { run } = require('../../db');
const { initDB } = require('./schema');

/**
 * The write that completes an e-mailed password reset, as ONE statement: the
 * new hash goes in and the token goes out only while the row still holds that
 * token and it has not expired. Two requests carrying the same link cannot
 * both succeed, and a link that expires between the check and the write is
 * refused. A database error throws.
 *
 * `keyMaterial` is the account's encryption key as it follows the new password
 * (auth/login/passwordResetKey.mts): the wrapping of the DEK under the new
 * password, or nulls that drop the old wrapping. It goes in the same statement
 * as the hash, so no row holds a new password next to a wrapping that password
 * cannot open. The key lockout counters are cleared with it: a completed reset
 * is the mailbox owner back at the door, and the failed unwraps that led here
 * were made with the password that is now gone.
 *
 * @param {string} userId
 * @param {string} tokenHash  SHA-256 of the token in the link
 * @param {string} passwordHash
 * @param {{ kekSalt: string | null, wrappedDEK: string | null } | null} [keyMaterial]  omit when the account holds no key
 * @returns {Promise<boolean>} whether this call consumed the token
 */
async function completePasswordReset(userId, tokenHash, passwordHash, keyMaterial = null) {
    if (!userId || !tokenHash || !passwordHash) return false;
    await initDB();
    /** @type {Array<string | null>} */
    const params = [passwordHash, userId, tokenHash];
    let keyColumns = '';
    if (keyMaterial) {
        keyColumns = ', "kekSalt" = $4, "wrappedDEK" = $5';
        params.push(keyMaterial.kekSalt, keyMaterial.wrappedDEK);
    }
    const { rowCount } = await run(
        `UPDATE users SET "passwordHash" = $1, password_changed_at = NOW(), "passwordResetRequired" = 0,
                password_reset_token_hash = NULL, password_reset_expires_at = NULL,
                "dekUnwrapFailures" = 0, "dekLockoutUntil" = NULL${keyColumns}
          WHERE id = $2 AND password_reset_token_hash = $3 AND password_reset_expires_at > NOW()`,
        params,
    );
    return rowCount > 0;
}

module.exports = { completePasswordReset };
