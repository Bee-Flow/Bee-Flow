/**
 * Unit tests for the org-health additions to connectorJwt:
 *
 *   - _unverifiedEmailDomain: best-effort DOMAIN-only extraction from an
 *     UNVERIFIED JWT payload, used to attribute 'no matching tenant key'
 *     failures to a `domain:<d>` bucket. Must never throw and never return
 *     more than the domain (no local part).
 *   - _resolveTenant is exported so the phone-home endpoint
 *     (connectorBootstrap POST /connector/status) reuses the single two-pass
 *     key resolver instead of duplicating it.
 *
 * Pure logic — no DB, no fetch.
 *
 * Run: cd server && node --test auth/connectorJwt.orgHealth.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const connectorJwt = require('./connectorJwt');
const { _unverifiedEmailDomain, _resolveTenant } = connectorJwt;

function b64url(obj) {
    return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function mintToken(payload, key = 'some-key') {
    const h = b64url({ alg: 'HS256', typ: 'JWT' });
    const p = b64url(payload);
    const sig = crypto.createHmac('sha256', key)
        .update(`${h}.${p}`)
        .digest('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${h}.${p}.${sig}`;
}

test('_resolveTenant is exported for the phone-home endpoint', () => {
    assert.equal(typeof _resolveTenant, 'function');
});

test('_unverifiedEmailDomain: extracts lower-cased domain only — never the local part', () => {
    const token = mintToken({ email: 'Tom.Smit@ACME.Example', sub: 'tom' });
    assert.equal(_unverifiedEmailDomain(token), 'acme.example');
});

test('_unverifiedEmailDomain: signature does not matter (deliberately unverified)', () => {
    const token = mintToken({ email: 'a@b.example' }, 'totally-wrong-key');
    assert.equal(_unverifiedEmailDomain(token), 'b.example');
});

test('_unverifiedEmailDomain: payload without email → null', () => {
    assert.equal(_unverifiedEmailDomain(mintToken({ sub: 'tom' })), null);
});

test('_unverifiedEmailDomain: email without @ → null', () => {
    assert.equal(_unverifiedEmailDomain(mintToken({ email: 'not-an-email' })), null);
});

test('_unverifiedEmailDomain: garbage input never throws', () => {
    assert.equal(_unverifiedEmailDomain('not-a-jwt'), null);
    assert.equal(_unverifiedEmailDomain(''), null);
    assert.equal(_unverifiedEmailDomain(null), null);
    assert.equal(_unverifiedEmailDomain(undefined), null);
    assert.equal(_unverifiedEmailDomain('a.%%%not-base64%%%.c'), null);
});

test('_unverifiedEmailDomain: non-JSON payload segment → null', () => {
    const notJson = Buffer.from('hello world').toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.equal(_unverifiedEmailDomain(`x.${notJson}.y`), null);
});
