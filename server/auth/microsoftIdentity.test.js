'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { verifyMicrosoftIdentity, assertGraphIdentity, isLegacyMicrosoftSession } = require('./microsoftIdentity');
const tid = '11111111-1111-1111-1111-111111111111';
const oid = '22222222-2222-2222-2222-222222222222';
const policy = { clientId: 'app', tenantId: tid, nonce: 'fresh-random-nonce' };
let jose, pair, jwks;
before(async () => {
    jose = await import('jose');
    pair = await jose.generateKeyPair('RS256');
    jwks = pair.publicKey;
});
async function token(overrides = {}, key = pair.privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return new jose.SignJWT({ tid, oid, sub: 'subject', nonce: policy.nonce,
        iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: 'app', iat: now, nbf: now, exp: now + 300, ...overrides })
        .setProtectedHeader({ alg: 'RS256' }).sign(key);
}
test('a signed Microsoft identity requires its tenant, nonce and matching Graph object ID', async () => {
    const identity = await verifyMicrosoftIdentity(await token(), policy, { jwks });
    assert.deepEqual(identity, { azureTenantId: tid, azureUserId: oid });
    assertGraphIdentity(identity, oid.toUpperCase());
    assert.throws(() => assertGraphIdentity(identity, tid), /mismatch/);
});
for (const [label, claims] of Object.entries({ nonce: { nonce: 'wrong' }, issuer: { iss: 'https://attacker.invalid' }, audience: { aud: 'other-app' }, expiry: { exp: 1 }, validity: { nbf: 9999999999 }, issuedInFuture: { iat: 9999999999 }, invalidIssuedAt: { iat: 'invalid' }, tenant: { tid: oid }, object: { oid: 'invalid' }, missingNonce: { nonce: undefined } })) {
    test(`rejects invalid ${label}`, async () => assert.rejects(verifyMicrosoftIdentity(await token(claims), policy, { jwks })));
}
test('rejects attacker signatures, unsigned and missing tokens', async () => {
    const attacker = await jose.generateKeyPair('RS256');
    await assert.rejects(verifyMicrosoftIdentity(await token({}, attacker.privateKey), policy, { jwks }));
    await assert.rejects(verifyMicrosoftIdentity('eyJhbGciOiJub25lIn0.e30.', policy, { jwks }));
    await assert.rejects(verifyMicrosoftIdentity(undefined, policy, { jwks }));
});
test('common accepts only a signed tenant issuer; organizations excludes consumer accounts', async () => {
    await verifyMicrosoftIdentity(await token(), { ...policy, tenantId: 'common' }, { jwks });
    await assert.rejects(verifyMicrosoftIdentity(await token({ tid: '9188040d-6c67-4c5b-b112-36a304b66dad' }), { ...policy, tenantId: 'organizations' }, { jwks }));
});
test('old Microsoft sessions expire, integration credentials and other providers survive', () => {
    const s = { isAuthenticated: true, oauthProvider: 'microsoft' };
    assert.ok(isLegacyMicrosoftSession(s));
    assert.ok(!isLegacyMicrosoftSession({ ...s, user: { id: 'local' }, microsoftIdentityVersion: 2,
        microsoftLoginIdentity: { azureTenantId: tid, azureUserId: oid, revision: '0' } }));
    assert.ok(isLegacyMicrosoftSession({ ...s, microsoftIdentityVersion: 2 }));
    assert.ok(!isLegacyMicrosoftSession({ ...s, oauthTokenSource: 'connector' }));
    assert.ok(!isLegacyMicrosoftSession({ ...s, oauthProvider: 'google' }));
    assert.ok(isLegacyMicrosoftSession({ ...s, oauthProvider: 'google', user: { provider: 'microsoft' }, oauthTokenSource: 'connector' }));
});
