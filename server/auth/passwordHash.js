// @typecheck strict
/**
 * Login password hashing — the one place that turns a password into a stored
 * `passwordHash` and checks a password against one.
 *
 * New hashes are argon2id. Existing rows keep their bcrypt hashes ($2a$/$2b$,
 * written by bcryptjs at cost 10, the built-in admin at cost 12) and keep
 * verifying; a successful sign-in upgrades them (see needsRehash and
 * auth/login/passwordRehash.js). bcryptjs stays a dependency for exactly that.
 *
 * PARAMETERS. The OWASP Password Storage Cheat Sheet's baseline for argon2id:
 * 19 MiB, two passes, one lane. The argon2id parameters in auth/encryption.js
 * (128 MiB, timeCost 4, four lanes) are NOT reused: they derive the KEK that
 * wraps a user's DEK, run once per unlock and are budgeted at 250–400 ms. A
 * login hash runs on every sign-in attempt, including every failed and every
 * unknown-user attempt (the dummy compare in passwordLoginRoutes.js), so
 * 128 MiB per attempt would turn the login endpoint into a memory lever, and a
 * compare that long would no longer sit under the failure-response floor in
 * loginThrottle.js (450 ms), which is what keeps all failure paths equally slow.
 */

const argon2 = require('argon2');
const bcrypt = require('bcryptjs');

/** @type {Readonly<import('argon2').HashOptions>} */
const ARGON2_LOGIN_OPTIONS = Object.freeze({
    type: argon2.argon2id,
    memoryCost: 19456, // KiB = 19 MiB
    timeCost: 2,
    parallelism: 1,
});

/** bcrypt only reads the first 72 bytes of a password. */
const BCRYPT_MAX_PASSWORD_BYTES = 72;

/** @param {unknown} stored */
function isArgon2Hash(stored) {
    return typeof stored === 'string' && stored.startsWith('$argon2');
}

/** @param {unknown} stored */
function isBcryptHash(stored) {
    return typeof stored === 'string' && /^\$2[aby]\$\d\d\$/.test(stored);
}

/**
 * Which algorithm new hashes use. ROLLOUT: verify() reads both formats in
 * every release, but writing argon2id stays off by default
 * (PASSWORD_HASH_ALGORITHM=bcrypt) until a release that can read argon2id is
 * the oldest one a rollback can return to. Writing argon2id earlier would lock
 * out every user who signed in between a deploy and a `rollout undo`, because
 * the previous server only knows bcrypt.
 * @returns {'argon2id' | 'bcrypt'}
 */
function writeAlgorithm() {
    return process.env.PASSWORD_HASH_ALGORITHM === 'argon2id' ? 'argon2id' : 'bcrypt';
}

/**
 * Hash a login password: argon2id (encoded PHC string with its own salt) when
 * PASSWORD_HASH_ALGORITHM=argon2id, otherwise bcrypt exactly as before
 * (cost 10 for user rows, 12 for the built-in admin).
 * @param {string} password
 * @param {{ bcryptRounds?: number }} [opts]
 * @returns {Promise<string>}
 */
async function hash(password, opts = {}) {
    if (writeAlgorithm() === 'argon2id') return argon2.hash(password, ARGON2_LOGIN_OPTIONS);
    return bcrypt.hash(password, opts.bcryptRounds ?? 10);
}

/**
 * Check a password against a stored hash: argon2 hashes through argon2, every
 * other value exactly as before through bcryptjs (which answers false for a
 * value that is not a bcrypt hash, and throws on the same illegal arguments it
 * always threw on).
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
async function verify(password, stored) {
    if (isArgon2Hash(stored)) return argon2.verify(stored, password);
    return bcrypt.compare(password, stored);
}

/**
 * Should this stored hash be replaced by hash(password) after a successful
 * verify? True for a bcrypt hash and for an argon2 hash with other parameters.
 *
 * Pass the password that just verified: a bcrypt hash checked a password
 * longer than 72 bytes on its first 72 bytes only, so the submitted password
 * may differ from the real one after that point. Re-hashing it would make the
 * account's real password stop working, so such a hash is left as it is.
 *
 * @param {string} stored
 * @param {string} [password]
 * @returns {boolean}
 */
function needsRehash(stored, password) {
    if (writeAlgorithm() !== 'argon2id') return false;
    if (isBcryptHash(stored)) {
        if (password !== undefined && Buffer.byteLength(String(password), 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) return false;
        return true;
    }
    if (isArgon2Hash(stored)) {
        try {
            return argon2.needsRehash(stored, ARGON2_LOGIN_OPTIONS);
        } catch (_) {
            return false;
        }
    }
    return false;
}

module.exports = { hash, verify, needsRehash, writeAlgorithm, isArgon2Hash, isBcryptHash, ARGON2_LOGIN_OPTIONS };
