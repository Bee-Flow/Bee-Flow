// @typecheck noImplicitAny
/**
 * Upgrade a stored login hash after a successful password sign-in.
 *
 * Existing accounts carry bcrypt hashes; new ones get argon2id
 * (auth/passwordHash.js). The only moment the server holds the plaintext that
 * matches an old hash is a sign-in that just verified it, so that is where the
 * hash is re-encoded and stored.
 *
 * - The credential does not change, so the account's password date stays put:
 *   the writes are the stores' compare-and-swap helpers, not updateUser.
 * - Both writes only replace the exact hash that was verified. A password
 *   changed or reset in between keeps the newer hash.
 * - Best effort. A failure here is logged and the sign-in carries on with the
 *   old hash, which keeps working; the next sign-in tries again.
 */

/**
 * @typedef {object} RehashDeps
 * @property {typeof import('../passwordHash')} passwords
 * @property {{ replacePasswordHash: (userId: string, expectedHash: string, newHash: string) => Promise<boolean> }} userStore
 * @property {{ replaceAdminPasswordHash: (expectedHash: string, newHash: string) => Promise<boolean> }} authConfigStore
 * @property {{ info: Function, warn: Function }} log
 */

/**
 * Dependencies are resolved on first use (the stores pull in the database), and
 * only the ones a caller did not supply.
 * @param {Partial<RehashDeps>} [deps]
 */
function createPasswordRehash(deps = {}) {
    /** @type {RehashDeps | undefined} */
    let resolved;
    const get = () => (resolved ||= {
        passwords: deps.passwords || require('../passwordHash'),
        userStore: deps.userStore || require('../../stores/userStore'),
        authConfigStore: deps.authConfigStore || require('../../stores/authConfigStore'),
        log: deps.log || require('../../telemetry/log'),
    });

    /**
     * @param {object} args
     * @param {string} args.userId         'admin' for the built-in operator
     * @param {string} args.storedHash     the hash `password` was just verified against
     * @param {string} args.password       the password that verified
     * @param {boolean} [args.isConfigAdmin] the hash came from the auth config (built-in admin)
     * @returns {Promise<boolean>} whether a new hash was stored
     */
    async function upgradeStoredHash({ userId, storedHash, password, isConfigAdmin = false }) {
        const { passwords, userStore, authConfigStore, log } = get();
        if (!passwords.needsRehash(storedHash, password)) return false;
        try {
            const upgraded = await passwords.hash(password);
            let stored = false;
            if (isConfigAdmin) {
                stored = await authConfigStore.replaceAdminPasswordHash(storedHash, upgraded);
            }
            // The built-in admin's users row holds a copy of the config hash
            // (setup, boot-init, finalizeLogin); it follows only while it is
            // still that same copy.
            const rowUpdated = await userStore.replacePasswordHash(userId, storedHash, upgraded);
            stored = stored || rowUpdated;
            if (stored) log.info(`[Auth] password hash upgraded to argon2id for user_id=${userId}`);
            return stored;
        } catch (e) {
            log.warn('[Auth] password hash upgrade failed (sign-in continues):', /** @type {Error} */ (e).message);
            return false;
        }
    }

    return { upgradeStoredHash };
}

module.exports = { createPasswordRehash, ...createPasswordRehash() };
