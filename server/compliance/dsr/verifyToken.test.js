'use strict';

// A fixed env secret keeps the test independent of the dev temp-file ladder.
process.env.DSR_VERIFY_SIGNING_KEY = 'test-dsr-verify-secret-0123456789abcdef-0123456789';

const test = require('node:test');
const assert = require('node:assert');
const verifyToken = require('./verifyToken');
const signedPayload = require('../../auth/lib/signedPayload');

const ROW = { id: 42, subject_email: 'Person@Example.org', organization_id: 'org_a' };
const NOW = Date.parse('2026-09-14T12:00:00Z');

test('mint → check round-trips and binds purpose, id, e-mail hash and org', () => {
    const { token, tokenHash, exp } = verifyToken.mint({ id: 42, email: 'person@example.org', orgId: 'org_a', now: NOW });
    assert.strictEqual(exp, NOW + verifyToken.TTL_MS);
    assert.match(tokenHash, /^[0-9a-f]{64}$/);
    // The token never carries the address itself.
    assert.ok(!Buffer.from(token.split('.')[0], 'base64').toString('utf8').includes('person@example.org'));

    const out = verifyToken.check(token, ROW, { now: NOW + 1000 });
    assert.ok(out);
    assert.strictEqual(out.payload.p, verifyToken.PURPOSE);
    assert.strictEqual(out.payload.id, 42);
    assert.strictEqual(out.tokenHash, tokenHash);
});

test('check is null for the wrong request, wrong e-mail, wrong org, or after expiry', () => {
    const { token } = verifyToken.mint({ id: 42, email: 'person@example.org', orgId: 'org_a', now: NOW });
    assert.strictEqual(verifyToken.check(token, { ...ROW, id: 43 }, { now: NOW }), null);
    assert.strictEqual(verifyToken.check(token, { ...ROW, subject_email: 'other@example.org' }, { now: NOW }), null);
    assert.strictEqual(verifyToken.check(token, { ...ROW, organization_id: 'org_b' }, { now: NOW }), null);
    assert.strictEqual(verifyToken.check(token, ROW, { now: NOW + verifyToken.TTL_MS + 1 }), null);
    assert.ok(verifyToken.check(token, ROW, { now: NOW + verifyToken.TTL_MS - 1 }));
});

test('check rejects a tampered signature, a foreign purpose and junk', () => {
    const { token } = verifyToken.mint({ id: 42, email: 'person@example.org', orgId: 'org_a', now: NOW });
    const [p, s] = token.split('.');
    assert.strictEqual(verifyToken.check(`${p}.${s.slice(0, -2)}xx`, ROW, { now: NOW }), null);
    // Signed with the right key but a different purpose (e.g. a share link).
    const foreign = signedPayload.sign(Buffer.from(process.env.DSR_VERIFY_SIGNING_KEY, 'utf8'), {
        p: 'public_share', id: 42, e: verifyToken.emailHash('person@example.org'), o: 'org_a', exp: NOW + 1000,
    });
    assert.strictEqual(verifyToken.check(foreign, ROW, { now: NOW }), null);
    assert.strictEqual(verifyToken.check('', ROW), null);
    assert.strictEqual(verifyToken.check(undefined, ROW), null);
    assert.strictEqual(verifyToken.check('a.b', ROW), null);
    assert.strictEqual(verifyToken.check(token, null), null);
});

test('emailHash is case/whitespace-insensitive so the stored row always matches', () => {
    assert.strictEqual(verifyToken.emailHash('  Person@Example.ORG '), verifyToken.emailHash('person@example.org'));
});
