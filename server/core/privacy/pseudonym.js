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
 * are about a million labels, so two people of one organisation can share a
 * label (in an organisation of 1,000 the odds are about one in three). The
 * label is therefore only ever a name: a row is keyed on `pseudonymId`, 64
 * bits of the same HMAC as hex, which does not collide in practice.
 *
 * Key domains: the people table (`people`, the default) is revealable, so its
 * labels can be matched to names after an audited reveal. Labels that must
 * stay pseudonymous after a reveal (the top users of a Studio kind,
 * `top-people`) come from a key of their own, so they never equal a person's
 * people-table label and a reveal cannot be joined to them.
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
const ID_HEX = 16;
/** The key label of each domain; `people` is the label the report has always used. */
const KEY_LABELS = Object.freeze({
    people: 'beeflow:adoption-pseudonym:v1:',
    'top-people': 'beeflow:adoption-top-people:v1:',
});

/**
 * @typedef {keyof typeof KEY_LABELS} PseudonymDomain
 * @typedef {{ domain?: PseudonymDomain }} PseudonymOptions
 */

/**
 * The organisation's pseudonym key in one domain.
 * @param {string} orgId
 * @param {string} secret
 * @param {PseudonymDomain} domain
 * @returns {Buffer}
 */
function orgKey(orgId, secret, domain) {
    const label = KEY_LABELS[domain];
    if (!label) throw new Error(`unknown pseudonym domain: ${String(domain)}`);
    return crypto.createHmac('sha256', secret).update(label + String(orgId)).digest();
}

/**
 * The HMAC of a person in an organisation and domain.
 * @param {string} userId
 * @param {string} orgId
 * @param {string} secret
 * @param {PseudonymOptions} [opts]
 * @returns {Buffer}
 */
function digestOf(userId, orgId, secret, opts = {}) {
    if (!secret) throw new Error('pseudonymFor needs a secret');
    return crypto.createHmac('sha256', orgKey(orgId, secret, opts.domain || 'people')).update(String(userId)).digest();
}

/**
 * The four-symbol code of a person in an organisation.
 * @param {string} userId
 * @param {string} orgId
 * @param {string} secret
 * @param {PseudonymOptions} [opts]
 * @returns {string}
 */
function pseudonymCode(userId, orgId, secret, opts = {}) {
    const digest = digestOf(userId, orgId, secret, opts);
    let out = '';
    for (let i = 0; i < SYMBOLS; i++) out += ALPHABET[digest[i] % ALPHABET.length];
    return out;
}

/**
 * "Member · K7Q2" for a person in an organisation.
 * @param {string} userId
 * @param {string} orgId
 * @param {string} secret
 * @param {PseudonymOptions} [opts]
 * @returns {string}
 */
function pseudonymFor(userId, orgId, secret, opts = {}) {
    return PREFIX + pseudonymCode(userId, orgId, secret, opts);
}

/**
 * The opaque row id of a pseudonymous person: 16 hex characters of the same
 * HMAC as the label, stable like it, and collision-free in practice where
 * the four-symbol label is not.
 * @param {string} userId
 * @param {string} orgId
 * @param {string} secret
 * @param {PseudonymOptions} [opts]
 * @returns {string}
 */
function pseudonymId(userId, orgId, secret, opts = {}) {
    return digestOf(userId, orgId, secret, opts).toString('hex').slice(0, ID_HEX);
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

module.exports = { pseudonymFor, pseudonymCode, pseudonymId, pseudonymSecret, ALPHABET, PREFIX, KEY_LABELS };
