// @typecheck
'use strict';

/**
 * Licence JWTs for tests: an RS256 key pair generated per process, a signer,
 * and a second key pair whose tokens the first public key must refuse.
 *
 *   const { publicKey, sign, signWithOtherKey, claims } = require('./licenseJwt.testkit');
 *   verify._setPublicKeyForTesting(publicKey);
 *   const token = sign(claims({ license_id: 'lic_1' }));
 */

const crypto = require('node:crypto');
const { EXPECTED_ISSUER } = require('./verify');

function keyPair() {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}

const main = keyPair();
const other = keyPair();

/** @param {string | Buffer} buf */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * @param {Record<string, unknown>} payload
 * @param {string} privateKey
 */
function signWith(payload, privateKey) {
    const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    return `${signingInput}.${b64url(sig)}`;
}

/** A token the testkit's public key accepts. @param {Record<string, unknown>} payload */
const sign = (payload) => signWith(payload, main.privateKey);
/** A well-formed token signed by a key nobody trusts. @param {Record<string, unknown>} payload */
const signWithOtherKey = (payload) => signWith(payload, other.privateKey);

/**
 * Valid licence claims for an hour from now, overridable per field.
 * @param {Record<string, unknown>} [over]
 */
function claims(over = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: EXPECTED_ISSUER, sub: 'org-a', tier: 'enterprise', license_id: 'lic_test', iat: now - 10, exp: now + 3600, ...over };
}

module.exports = { publicKey: main.publicKey, sign, signWithOtherKey, claims };
