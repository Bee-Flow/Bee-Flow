/**
 * Unit tests for modules/entitlements.js — module entitlement grant verifier.
 *
 * Generates an ephemeral RSA-2048 keypair per run (same style as
 * license/verify.test.js), signs grant tokens with the pinned claims + a kid,
 * and points verifyModuleGrant at the ephemeral public key via
 * publicKeyResolver so nothing touches the real key infrastructure.
 *
 * Run: node --test modules/entitlements.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifyModuleGrant, decodeGrantUnverified } = require('./entitlements');

// ── Ephemeral keypair ────────────────────────────────────────────────────
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const KID = 'test-kid-001';
const resolver = (kid) => (kid === KID ? publicKey : null);

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(payload, { alg = 'RS256', headerOverrides = {} } = {}) {
    const header = { alg, typ: 'JWT', kid: KID, ...headerOverrides };
    const encHeader = b64url(JSON.stringify(header));
    const encPayload = b64url(JSON.stringify(payload));
    const signingInput = `${encHeader}.${encPayload}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${signingInput}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);

// Pinned grant-token claim set. Individual tests override single fields.
function grant(overrides = {}) {
    return {
        iss: 'license.beeflow.nl',
        aud: 'beeflow-module',
        token_use: 'module_grant',
        sub: 'lic_123',
        subject_type: 'license',
        module_id: 'security_scan',
        entitlement_id: 'ent_1',
        purchase_id: 'pur_1',
        kind: 'subscription',
        iat: now,
        nbf: now,
        exp: now + 86400,
        ...overrides,
    };
}

const OPTS = { moduleId: 'security_scan', now, publicKeyResolver: resolver };

// ── Happy path ───────────────────────────────────────────────────────────
test('valid grant → { valid:true, payload }', async () => {
    const r = await verifyModuleGrant(sign(grant()), OPTS);
    assert.strictEqual(r.valid, true, `expected valid, got: ${r.error}`);
    assert.strictEqual(r.payload.module_id, 'security_scan');
    assert.strictEqual(r.payload.sub, 'lic_123');
});

test('valid grant honors subjectIds allow-list', async () => {
    const r = await verifyModuleGrant(sign(grant()), {
        ...OPTS,
        subjectIds: ['lic_999', 'lic_123'],
    });
    assert.strictEqual(r.valid, true, `expected valid, got: ${r.error}`);
});

test('internal issuer is accepted', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ iss: 'license.beeflow.nl/internal' })), OPTS);
    assert.strictEqual(r.valid, true, `expected valid, got: ${r.error}`);
});

// ── Failure slugs ────────────────────────────────────────────────────────
test('tampered signature → invalid_signature', async () => {
    const token = sign(grant());
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${b64url(Buffer.alloc(256, 7))}`;
    const r = await verifyModuleGrant(tampered, OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'invalid_signature');
});

test('signed by a different key → invalid_signature', async () => {
    // Resolver returns null for an unknown kid ⇒ no key ⇒ signature fails.
    const r = await verifyModuleGrant(
        sign(grant(), { headerOverrides: { kid: 'unknown-kid' } }), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'invalid_signature');
});

test('wrong module_id → module_mismatch', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ module_id: 'compliance_hub' })), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'module_mismatch');
});

test('wrong audience → bad_audience', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ aud: 'beeflow-core' })), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'bad_audience');
});

test('wrong token_use → bad_token_use', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ token_use: 'license' })), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'bad_token_use');
});

test('expired exp → expired', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ iat: now - 7200, nbf: now - 7200, exp: now - 3600 })), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'expired');
});

test('bad issuer → bad_issuer', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ iss: 'attacker.example.com' })), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'bad_issuer');
});

test('subject not in allow-list → subject_mismatch', async () => {
    const r = await verifyModuleGrant(sign(grant()), {
        ...OPTS,
        subjectIds: ['lic_999', 'install_abc'],
    });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'subject_mismatch');
});

test('nbf in the future beyond skew → not_yet_valid', async () => {
    const r = await verifyModuleGrant(
        sign(grant({ nbf: now + 3600 })), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'not_yet_valid');
});

test('non-RS256 alg header → bad_alg', async () => {
    const r = await verifyModuleGrant(
        sign(grant(), { headerOverrides: { alg: 'HS256' } }), OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'bad_alg');
});

test('malformed token → malformed', async () => {
    const r = await verifyModuleGrant('not-a-jwt', OPTS);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'malformed');
});

// ── decodeGrantUnverified helper ─────────────────────────────────────────
test('decodeGrantUnverified returns payload without verifying', () => {
    const payload = decodeGrantUnverified(sign(grant()));
    assert.strictEqual(payload.module_id, 'security_scan');
    assert.strictEqual(payload.kind, 'subscription');
});

test('decodeGrantUnverified returns null on junk', () => {
    assert.strictEqual(decodeGrantUnverified('garbage'), null);
    assert.strictEqual(decodeGrantUnverified(''), null);
    assert.strictEqual(decodeGrantUnverified(null), null);
});
