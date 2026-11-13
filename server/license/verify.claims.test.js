'use strict';

/**
 * license/verify.js: the time claims at their boundaries, and which public key
 * a production server will take.
 *
 *   - `exp` is the first second the licence is no longer valid: a token whose
 *     `exp` is now is expired, one second later it is not.
 *   - `nbf` is honoured with 60 seconds of clock leeway: a token that starts
 *     further ahead than that is refused, one that starts within it is not.
 *   - the bundled development key is refused in production unless
 *     LICENSE_ALLOW_BUNDLED_KEY=true, so a deployment that forgot its key
 *     cannot validate development-signed tokens.
 *
 * The key pair is generated per run. The bundled key file is not in a fresh
 * clone, so the test answers for that one path on the shared `fs` object
 * (verify.js calls fs.existsSync / fs.readFileSync as members).
 *
 * Run: cd server && node --test license/verify.claims.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const verify = require('./verify');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A licence JWT signed with this run's private key. */
function sign(claims) {
    const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    return `${signingInput}.${b64url(sig)}`;
}

const NOW = 1_900_000_000;
const claims = (over) => ({ iss: verify.EXPECTED_ISSUER, sub: 'org_test', tier: 'pro', license_id: 'lic_claims', iat: NOW - 10, exp: NOW + 3600, ...over });
const check = (over) => verify.verifyToken(sign(claims(over)), { now: NOW, publicKeyOverride: publicKey });

// ── exp ─────────────────────────────────────────────────────────────────

test('exp: a token that expires this very second is expired', async () => {
    assert.deepEqual(await check({ exp: NOW }), { valid: false, error: 'token_expired' });
});

test('exp: a token that expires one second from now is still valid', async () => {
    const r = await check({ exp: NOW + 1 });
    assert.equal(r.valid, true, r.error);
});

// ── nbf ─────────────────────────────────────────────────────────────────

test('nbf: a token that starts beyond the 60-second leeway is not yet valid', async () => {
    assert.deepEqual(await check({ nbf: NOW + 61 }), { valid: false, error: 'token_not_yet_valid' });
    assert.deepEqual(await check({ nbf: NOW + 86400 }), { valid: false, error: 'token_not_yet_valid' });
});

test('nbf: a token that starts within the leeway, now or in the past is valid', async () => {
    for (const nbf of [NOW + 60, NOW, NOW - 3600]) {
        const r = await check({ nbf });
        assert.equal(r.valid, true, `nbf ${nbf - NOW}s from now: ${r.error}`);
    }
});

test('nbf: a token without the claim is valid', async () => {
    const r = await check({});
    assert.equal(r.valid, true, r.error);
});

// ── The bundled key in production ───────────────────────────────────────

const BUNDLED = /bundled-public-key\.pem$/;
const realExists = fs.existsSync;
const realRead = fs.readFileSync;
const ENV_KEYS = ['NODE_ENV', 'LICENSE_PUBLIC_KEY', 'LICENSE_PUBLIC_KEY_FILE', 'LICENSE_ALLOW_BUNDLED_KEY'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** A server whose only key is the bundled one, in the given environment. */
function serverWithOnlyTheBundledKey(env) {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    fs.existsSync = (p) => (BUNDLED.test(String(p)) ? true : realExists(p));
    fs.readFileSync = (p, ...rest) => (BUNDLED.test(String(p)) ? publicKey : realRead(p, ...rest));
    verify._setPublicKeyForTesting(null);
}

function restoreServer() {
    fs.existsSync = realExists;
    fs.readFileSync = realRead;
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    verify._setPublicKeyForTesting(null);
}

beforeEach(restoreServer);
after(restoreServer);

test('production: the bundled key is refused, so a token it signed has no key to verify against', async () => {
    serverWithOnlyTheBundledKey({ NODE_ENV: 'production' });
    assert.deepEqual(verify.loadPublicKey(), { key: null, source: null });
    assert.deepEqual(await verify.verifyToken(sign(claims({})), { now: NOW }), { valid: false, error: 'no_public_key_configured' });
});

test('production: any value of LICENSE_ALLOW_BUNDLED_KEY other than "true" still refuses it', () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
        serverWithOnlyTheBundledKey({ NODE_ENV: 'production', LICENSE_ALLOW_BUNDLED_KEY: value });
        assert.deepEqual(verify.loadPublicKey(), { key: null, source: null }, `LICENSE_ALLOW_BUNDLED_KEY=${JSON.stringify(value)}`);
    }
});

test('production with LICENSE_ALLOW_BUNDLED_KEY=true: the bundled key is taken', async () => {
    serverWithOnlyTheBundledKey({ NODE_ENV: 'production', LICENSE_ALLOW_BUNDLED_KEY: 'true' });
    assert.deepEqual(verify.loadPublicKey(), { key: publicKey, source: 'bundled' });
    const r = await verify.verifyToken(sign(claims({})), { now: NOW });
    assert.equal(r.valid, true, r.error);
});

test('outside production the bundled key is taken without the switch', () => {
    serverWithOnlyTheBundledKey({ NODE_ENV: 'development' });
    assert.deepEqual(verify.loadPublicKey(), { key: publicKey, source: 'bundled' });
});

test('production: a configured key is used and the bundled one is never consulted', () => {
    serverWithOnlyTheBundledKey({ NODE_ENV: 'production', LICENSE_PUBLIC_KEY: publicKey });
    assert.deepEqual(verify.loadPublicKey(), { key: publicKey, source: 'env' });
});
