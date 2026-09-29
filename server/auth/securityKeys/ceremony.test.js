/**
 * Both ceremonies, end to end through the real verifier, against a software
 * key that signs exactly what a YubiKey signs. Each refusal test changes ONE
 * thing a phishing relay or a cloned key would get wrong, so a pass means the
 * verifier caught that thing and not something incidental.
 *
 * Run: cd server && node --test auth/securityKeys/ceremony.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ceremony = require('./ceremony');
const { createSoftAuthenticator } = require('./softAuthenticator.testkit');

const RP = { rpID: 'beeflow.example', origin: 'https://beeflow.example' };

async function registered(authenticator = createSoftAuthenticator()) {
    const options = await ceremony.registrationOptions({ rp: RP, userName: 'ada', existingKeys: [] });
    const record = ceremony.challengeRecord(options, RP);
    const result = await ceremony.verifyRegistration({
        response: authenticator.register(options, { origin: RP.origin }),
        record,
    });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    return { authenticator, key: result.key };
}

async function loginOptions(key) {
    const options = await ceremony.authenticationOptions({ rp: RP, keys: [key] });
    return { options, record: ceremony.challengeRecord(options, RP) };
}

// ── Registration ───────────────────────────────────────────────────────────

test('registration options ask for a security key without attestation, PIN or resident slot', async () => {
    const options = await ceremony.registrationOptions({
        rp: RP, userName: 'ada', displayName: 'Ada',
        existingKeys: [{ credentialId: 'AAAA', publicKey: '', signCount: 0, transports: ['usb'] }],
    });
    assert.equal(options.rp.id, 'beeflow.example');
    assert.equal(options.attestation, 'none');
    assert.equal(options.authenticatorSelection?.residentKey, 'discouraged');
    assert.equal(options.authenticatorSelection?.userVerification, 'discouraged');
    assert.deepEqual(options.hints, ['security-key']);
    assert.deepEqual(options.excludeCredentials?.map((c) => c.id), ['AAAA'], 'an already registered key is excluded');
});

test('a registration answer is turned into a storable key', async () => {
    const { authenticator, key } = await registered();
    assert.equal(key.credentialId, authenticator.credentialId);
    assert.ok(key.publicKey.length > 40, 'the COSE public key is kept, base64url');
    assert.deepEqual(key.transports, ['nfc', 'usb']);
    assert.equal(key.signCount, 0);
});

test('registration made on another origin is refused', async () => {
    const options = await ceremony.registrationOptions({ rp: RP, userName: 'ada', existingKeys: [] });
    const result = await ceremony.verifyRegistration({
        response: createSoftAuthenticator().register(options, { origin: 'https://evil.test' }),
        record: ceremony.challengeRecord(options, RP),
    });
    assert.equal(result.ok, false);
});

test('registration answering a different challenge is refused', async () => {
    const options = await ceremony.registrationOptions({ rp: RP, userName: 'ada', existingKeys: [] });
    const result = await ceremony.verifyRegistration({
        response: createSoftAuthenticator().register(options, { origin: RP.origin, challenge: 'c29tZXRoaW5nLWVsc2U' }),
        record: ceremony.challengeRecord(options, RP),
    });
    assert.equal(result.ok, false);
});

// ── Authentication ─────────────────────────────────────────────────────────

test('a touch of the registered key verifies and moves the counter', async () => {
    const { authenticator, key } = await registered();
    const { options, record } = await loginOptions(key);
    assert.deepEqual(options.allowCredentials?.map((c) => c.id), [key.credentialId]);
    assert.equal(options.userVerification, 'discouraged');

    const result = await ceremony.verifyAuthentication({
        response: authenticator.authenticate(options, { origin: RP.origin }), record, key,
    });
    assert.deepEqual(result, { ok: true, newCounter: 1 });
});

test('an answer relayed through another origin is refused', async () => {
    const { authenticator, key } = await registered();
    const { options, record } = await loginOptions(key);
    const result = await ceremony.verifyAuthentication({
        response: authenticator.authenticate(options, { origin: 'https://beeflow-login.evil.test' }), record, key,
    });
    assert.equal(result.ok, false);
});

test('an answer signed for another RP ID is refused', async () => {
    const { authenticator, key } = await registered();
    const { options, record } = await loginOptions(key);
    const result = await ceremony.verifyAuthentication({
        response: authenticator.authenticate(options, { origin: RP.origin, rpID: 'evil.test' }), record, key,
    });
    assert.equal(result.ok, false);
});

test('a signature from a different key is refused', async () => {
    const { key } = await registered();
    const { options, record } = await loginOptions(key);
    const impostor = createSoftAuthenticator();
    const result = await ceremony.verifyAuthentication({
        response: impostor.authenticate(options, { origin: RP.origin }), record, key,
    });
    assert.equal(result.ok, false);
});

test('a counter that did not move forward is refused: that is a cloned key', async () => {
    const { authenticator, key } = await registered();
    const { options, record } = await loginOptions(key);
    const result = await ceremony.verifyAuthentication({
        response: authenticator.authenticate(options, { origin: RP.origin, counterValue: 7 }),
        record,
        key: { ...key, signCount: 7 },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /counter/i);
});

// ── Challenge bookkeeping ──────────────────────────────────────────────────

test('a challenge is taken once', () => {
    const holder = { c: { challenge: 'abc', rpID: RP.rpID, origin: RP.origin, issuedAt: 1_000 } };
    assert.equal(ceremony.takeChallenge(holder, 'c', 2_000)?.challenge, 'abc');
    assert.equal(ceremony.takeChallenge(holder, 'c', 2_000), null);
});

test('an expired challenge is refused, and removed all the same', () => {
    const holder = { c: { challenge: 'abc', rpID: RP.rpID, origin: RP.origin, issuedAt: 0 } };
    assert.equal(ceremony.takeChallenge(holder, 'c', ceremony.CHALLENGE_TTL_MS), null);
    assert.equal('c' in holder, false);
});

test('a malformed challenge record is refused', () => {
    assert.equal(ceremony.takeChallenge({ c: 'abc' }, 'c', 0), null);
    assert.equal(ceremony.takeChallenge({ c: { challenge: 'abc' } }, 'c', 0), null);
    assert.equal(ceremony.takeChallenge(null, 'c', 0), null);
});
