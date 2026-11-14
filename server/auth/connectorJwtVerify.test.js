'use strict';

/**
 * auth/connectorJwtVerify.js: what an HS256 connector token must be before
 * its payload is believed, and the domain read of a token that did not verify.
 *
 *   - signed with the tenant key, as HS256, typ JWT when a typ is given
 *   - carries an `exp` that is in the future and at most 15 minutes plus
 *     60 seconds of clock skew away
 *   - `nbf`, `iss` and `aud` are optional, and refused when present and wrong
 *
 * The clock is pinned with node:test's mock timers, so the boundaries are
 * exact seconds.
 *
 * Run: cd server && node --test auth/connectorJwtVerify.test.js
 */

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _verifyHs256, _unverifiedEmailDomain, MAX_TOKEN_LIFETIME_SECONDS } = require('./connectorJwtVerify');

const KEY = 'tenant-key-0123456789abcdef';
const NOW = 1_900_000_000;
const CEILING = MAX_TOKEN_LIFETIME_SECONDS + 60;

const b64url = (s) => Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A connector token: header and payload as given, HMAC-SHA256 over them with `key`. */
function mint(payload, { key = KEY, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.createHmac('sha256', key).update(input).digest();
    return `${input}.${b64url(sig)}`;
}
const body = (over = {}) => ({ sub: 'alice', email: 'alice@example.org', exp: NOW + 300, ...over });

beforeEach(() => { mock.timers.enable({ apis: ['Date'], now: NOW * 1000 }); });
afterEach(() => { mock.timers.reset(); });

test('a token signed with the tenant key and a short expiry verifies and yields its payload', () => {
    const payload = _verifyHs256(mint(body({ iss: 'nextcloud-connector', aud: 'beeflow.nl', nbf: NOW })), KEY);
    assert.equal(payload.sub, 'alice');
    assert.equal(payload.email, 'alice@example.org');
});

// ── Shape and algorithm ─────────────────────────────────────────────────

test('a token without three segments is malformed', () => {
    const [h, p] = mint(body()).split('.');
    assert.throws(() => _verifyHs256(`${h}.${p}`, KEY), /malformed JWT/);
    assert.throws(() => _verifyHs256(`${mint(body())}.extra`, KEY), /malformed JWT/);
});

test('any algorithm other than HS256 is refused, "none" included', () => {
    for (const alg of ['none', 'HS512', 'RS256', undefined]) {
        assert.throws(() => _verifyHs256(mint(body(), { header: { alg, typ: 'JWT' } }), KEY), /unexpected alg/, String(alg));
    }
});

test('a typ other than JWT is refused; a header without typ is accepted', () => {
    assert.throws(() => _verifyHs256(mint(body(), { header: { alg: 'HS256', typ: 'JWS' } }), KEY), /unexpected typ/);
    assert.equal(_verifyHs256(mint(body(), { header: { alg: 'HS256' } }), KEY).sub, 'alice');
});

// ── Signature ───────────────────────────────────────────────────────────

test('a token signed with another tenant key is refused', () => {
    assert.throws(() => _verifyHs256(mint(body(), { key: 'another-tenant-key' }), KEY), /signature mismatch/);
});

test('a payload changed after signing is refused', () => {
    const [h, , s] = mint(body()).split('.');
    const forged = `${h}.${b64url(JSON.stringify(body({ sub: 'root' })))}.${s}`;
    assert.throws(() => _verifyHs256(forged, KEY), /signature mismatch/);
});

test('a truncated or empty signature is refused, not compared past its end', () => {
    const [h, p, s] = mint(body()).split('.');
    assert.throws(() => _verifyHs256(`${h}.${p}.${s.slice(0, 10)}`, KEY), /signature mismatch/);
    assert.throws(() => _verifyHs256(`${h}.${p}.`, KEY), /signature mismatch/);
});

// ── Expiry ──────────────────────────────────────────────────────────────

test('a token without a numeric exp is refused', () => {
    assert.throws(() => _verifyHs256(mint({ sub: 'alice' }), KEY), /token has no expiry/);
    assert.throws(() => _verifyHs256(mint(body({ exp: String(NOW + 60) })), KEY), /token has no expiry/);
    assert.throws(() => _verifyHs256(mint(body({ exp: null })), KEY), /token has no expiry/);
});

test('exp is the first second the token is no longer valid', () => {
    assert.throws(() => _verifyHs256(mint(body({ exp: NOW })), KEY), /token expired/);
    assert.throws(() => _verifyHs256(mint(body({ exp: NOW - 1 })), KEY), /token expired/);
    assert.equal(_verifyHs256(mint(body({ exp: NOW + 1 })), KEY).sub, 'alice');
});

test('a token may live at most 15 minutes plus 60 seconds of skew', () => {
    assert.equal(_verifyHs256(mint(body({ exp: NOW + CEILING })), KEY).sub, 'alice');
    assert.throws(() => _verifyHs256(mint(body({ exp: NOW + CEILING + 1 })), KEY), /token lifetime too long/);
    assert.throws(() => _verifyHs256(mint(body({ exp: NOW + 86400 * 365 })), KEY), /token lifetime too long/);
});

test('nbf in the future is refused without leeway; nbf now is accepted', () => {
    assert.throws(() => _verifyHs256(mint(body({ nbf: NOW + 1 })), KEY), /token not yet valid/);
    assert.equal(_verifyHs256(mint(body({ nbf: NOW })), KEY).sub, 'alice');
});

// ── Issuer and audience ─────────────────────────────────────────────────

test('an issuer other than the connector is refused; no issuer is accepted', () => {
    assert.throws(() => _verifyHs256(mint(body({ iss: 'license.beeflow.nl' })), KEY), /unexpected iss/);
    assert.equal(_verifyHs256(mint(body()), KEY).sub, 'alice');
});

test('an audience other than beeflow.nl is refused', () => {
    assert.throws(() => _verifyHs256(mint(body({ aud: 'other.example' })), KEY), /unexpected aud/);
});

// ── The domain read of an unverified token ──────────────────────────────

test('the domain of an unverified token is read lower-cased and trimmed, never the whole address', () => {
    const forged = mint(body({ email: 'Mallory@Example.ORG ' }), { key: 'not-the-key' });
    assert.equal(_unverifiedEmailDomain(forged), 'example.org');
});

test('a token without an e-mail, or that is no token at all, yields null and never throws', () => {
    assert.equal(_unverifiedEmailDomain(mint({ sub: 'x', exp: NOW + 60 })), null);
    assert.equal(_unverifiedEmailDomain(mint(body({ email: 'no-at-sign' }))), null);
    for (const junk of ['', 'a.b.c', 'only-one-part', null, undefined, 42, {}]) {
        assert.equal(_unverifiedEmailDomain(junk), null, JSON.stringify(junk));
    }
});
