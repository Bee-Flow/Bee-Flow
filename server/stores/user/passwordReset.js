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
 * @param {string} userId
 * @param {string} tokenHash  SHA-256 of the token in the link
 * @param {string} passwordHash
 * @returns {Promise<boolean>} whether this call consumed the token
 */
async function completePasswordReset(userId, tokenHash, passwordHash) {
    if (!userId || !tokenHash || !passwordHash) return false;
    await initDB();
    const { rowCount } = await run(
        `UPDATE users SET "passwordHash" = $1, password_changed_at = NOW(), "passwordResetRequired" = 0,
                password_reset_token_hash = NULL, password_reset_expires_at = NULL
          WHERE id = $2 AND password_reset_token_hash = $3 AND password_reset_expires_at > NOW()`,
        [passwordHash, userId, tokenHash],
    );
    return rowCount > 0;
}

module.exports = { completePasswordReset };
