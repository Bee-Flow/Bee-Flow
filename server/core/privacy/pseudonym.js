// @typecheck strict
/**
 * A stable, organisation-scoped pseudonym for a person: "Member · K7Q2".
 *
 * The Adoption report lists people pseudonymously by default (an admin reads
 * that a member is active, not who). The pseudonym has to be:
 *
 *   - STABLE across requests and restarts, so the same person keeps the same
 *     label from one week to the next and a reveal can be matched to it;
 *   - SCOPED to the organisation, so the same account in two organisations
 *     carries two unrelated labels and a label cannot be joined across tenants;
 *   - KEYED with a server secret, so a label cannot be recomputed from a user
 *     id by anyone who only knows the id (user ids derive from usernames).
 *
 * HMAC-SHA256 under a per-organisation key derived from the install's secret,
 * read as four symbols of a 32-symbol alphabet without 0/O/1/I. Four symbols
 * are about a million labels: a collision inside one organisation is possible
 * and harmless (two rows read the same label; the ids stay distinct).
 *
 * The secret: SESSION_SECRET, which boot/session.js refuses to start without
 * (at least 32 characters) and which stays the same across restarts. The
 * optional USAGE_HASH_SALT of jobs/usageOpenObservePush.js is empty unless that
 * export is configured, so it cannot carry a feature every install has. The key
 * is derived with a fixed label rather than used as is, so the pseudonym never
 * shares a key with the session cookies (the integrationCacheStore pattern).
 * Rotating SESSION_SECRET re-labels everyone, and signs everyone out as well.
 */

'use strict';

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SYMBOLS = 4;
const PREFIX = 'Member · ';
const KEY_LABEL = 'beeflow:adoption-pseudonym:v1:';

/**
 * The organisation's pseudonym key.
 * @param {string} orgId
 * @param {string} secret
 * @returns {Buffer}
 */
function orgKey(orgId, secret) {
    return crypto.createHmac('sha256', secret).update(KEY_LABEL + String(orgId)).digest();
}

/**
 * The four-symbol code of a person in an organisation.
 * @param {string} userId
 * @param {string} orgId
 * @param {string} secret
 * @returns {string}
 */
function pseudonymCode(userId, orgId, secret) {
    if (!secret) throw new Error('pseudonymFor needs a secret');
    const digest = crypto.createHmac('sha256', orgKey(orgId, secret)).update(String(userId)).digest();
    let out = '';
    for (let i = 0; i < SYMBOLS; i++) out += ALPHABET[digest[i] % ALPHABET.length];
    return out;
}

/**
 * "Member · K7Q2" for a person in an organisation.
 * @param {string} userId
 * @param {string} orgId
 * @param {string} secret
 * @returns {string}
 */
function pseudonymFor(userId, orgId, secret) {
    return PREFIX + pseudonymCode(userId, orgId, secret);
}

/**
 * The install's pseudonym secret (SESSION_SECRET). Throws when it is missing or
 * shorter than boot/session.js accepts: a weak or absent key would make the
 * labels recomputable, and a random fallback would change them on restart.
 * @returns {string}
 */
function pseudonymSecret() {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters) to pseudonymise people');
    return s;
}

module.exports = { pseudonymFor, pseudonymCode, pseudonymSecret, ALPHABET, PREFIX };
