// @typecheck
// Security keys — the WebAuthn credentials (YubiKey and other FIDO2
// authenticators) a user registered as a second factor. The ceremony itself
// lives in auth/securityKeys/; this file only stores and reads the rows.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');

/**
 * @typedef {object} SecurityKey
 * @property {string} id
 * @property {string} userId
 * @property {string} credentialId   base64url, as the authenticator reports it
 * @property {string} publicKey      base64url of the COSE public key
 * @property {number} signCount
 * @property {string[]} transports
 * @property {string} rpId
 * @property {string} name
 * @property {string|null} aaguid
 * @property {boolean} backedUp
 * @property {string} createdAt
 * @property {string|null} lastUsedAt
 */

function parseTransports(raw) {
    try {
        const arr = JSON.parse(raw || '[]');
        return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
    } catch (_) {
        return [];
    }
}

/** @returns {SecurityKey|null} */
function toSecurityKey(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        credentialId: row.credential_id,
        publicKey: row.public_key,
        signCount: Number(row.sign_count) || 0,
        transports: parseTransports(row.transports),
        rpId: row.rp_id,
        name: row.name,
        aaguid: row.aaguid || null,
        backedUp: !!row.backed_up,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        lastUsedAt: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : (row.last_used_at || null),
    };
}

/** @returns {Promise<SecurityKey[]>} */
async function listSecurityKeys(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM user_security_keys WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
    );
    return rows.map(toSecurityKey);
}

/**
 * Store a verified credential. A credential id that is already registered —
 * to this user or anyone else — raises the unique-violation (23505) for the
 * caller to turn into a refusal.
 *
 * @param {{ userId: string, credentialId: string, publicKey: string, signCount: number,
 *   transports: string[], rpId: string, name: string, aaguid?: string|null, backedUp?: boolean }} key
 * @returns {Promise<SecurityKey|null>}
 */
async function addSecurityKey(key) {
    await initDB();
    const row = await getOne(`
        INSERT INTO user_security_keys
            (id, user_id, credential_id, public_key, sign_count, transports, rp_id, name, aaguid, backed_up)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `, [
        crypto.randomUUID(), key.userId, key.credentialId, key.publicKey, key.signCount || 0,
        JSON.stringify(key.transports || []), key.rpId, key.name, key.aaguid || null, !!key.backedUp,
    ]);
    return toSecurityKey(row);
}

/** Scoped to the owner, so one user can never rename another user's key. */
async function renameSecurityKey(userId, id, name) {
    await initDB();
    const res = await run(
        `UPDATE user_security_keys SET name = $3 WHERE id = $2 AND user_id = $1`,
        [userId, id, name],
    );
    return (res?.rowCount || 0) > 0;
}

/** Scoped to the owner, so one user can never remove another user's key. */
async function deleteSecurityKey(userId, id) {
    await initDB();
    const res = await run(`DELETE FROM user_security_keys WHERE id = $2 AND user_id = $1`, [userId, id]);
    return (res?.rowCount || 0) > 0;
}

/** Turning two-factor authentication off takes every key with it. */
async function deleteAllSecurityKeys(userId) {
    await initDB();
    const res = await run(`DELETE FROM user_security_keys WHERE user_id = $1`, [userId]);
    return res?.rowCount || 0;
}

/**
 * Record a successful sign-in with this key: the authenticator's new signature
 * counter (a clone detector — see ceremony.verifyAuthentication) and the time.
 */
async function recordSecurityKeyUse(userId, id, signCount) {
    await initDB();
    const res = await run(
        `UPDATE user_security_keys SET sign_count = $3, last_used_at = NOW() WHERE id = $2 AND user_id = $1`,
        [userId, id, signCount],
    );
    return (res?.rowCount || 0) > 0;
}

module.exports = {
    listSecurityKeys,
    addSecurityKey,
    renameSecurityKey,
    deleteSecurityKey,
    deleteAllSecurityKeys,
    recordSecurityKeyUse,
};
