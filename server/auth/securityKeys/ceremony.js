// @typecheck
/**
 * The two WebAuthn ceremonies a security key (a YubiKey, or any FIDO2 key)
 * goes through: registration, once, from Settings → Security; and
 * authentication, as the second factor of a password sign-in.
 *
 * Choices, each for a reason:
 *   - attestation 'none'. We do not need to know which make of key it is, and
 *     asking for attestation hands us a device certificate we would then hold.
 *   - residentKey 'discouraged'. A second factor needs no discoverable
 *     credential, and resident slots on a key are few (25 on older YubiKeys).
 *   - userVerification 'discouraged'. The password is the first factor; the
 *     key proves possession with a touch, as with any other 2FA key. A key
 *     with a PIN set is not asked for it.
 *
 * A challenge lives in the session, bound to the RP ID and origin it was
 * issued for, for CHALLENGE_TTL_MS, and is used once: `takeChallenge` removes
 * it before verification, so a failed attempt cannot be replayed against it.
 */

const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'Bee Flow';
const CHALLENGE_TTL_MS = 5 * 60_000;
// How long the browser keeps its "touch your key" prompt open.
const PROMPT_TIMEOUT_MS = 2 * 60_000;

/**
 * @typedef {{ rpID: string, origin: string }} RelyingParty
 * @typedef {{ challenge: string, rpID: string, origin: string, issuedAt: number, name?: string, proven?: boolean }} ChallengeRecord
 *   `name` and `proven` ride along on a registration challenge (managementRoutes.js).
 * @typedef {{ credentialId: string, publicKey: string, signCount: number, transports: string[] }} StoredKey
 */

/**
 * @param {{ rp: RelyingParty, userName: string, displayName?: string, existingKeys: StoredKey[] }} args
 */
async function registrationOptions({ rp, userName, displayName, existingKeys }) {
    return generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpID,
        userName,
        userDisplayName: displayName || userName,
        timeout: PROMPT_TIMEOUT_MS,
        attestationType: 'none',
        // The same key twice would be two rows for one device; the browser
        // tells the user it is already registered instead.
        excludeCredentials: existingKeys.map((k) => ({ id: k.credentialId, transports: k.transports })),
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'discouraged' },
        preferredAuthenticatorType: 'securityKey',
    });
}

/**
 * @param {{ rp: RelyingParty, keys: StoredKey[] }} args
 */
async function authenticationOptions({ rp, keys }) {
    return generateAuthenticationOptions({
        rpID: rp.rpID,
        timeout: PROMPT_TIMEOUT_MS,
        allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports })),
        userVerification: 'discouraged',
    });
}

/**
 * @param {{ challenge: string }} options
 * @param {RelyingParty} rp
 * @returns {ChallengeRecord}
 */
function challengeRecord(options, rp, now = Date.now()) {
    return { challenge: options.challenge, rpID: rp.rpID, origin: rp.origin, issuedAt: now };
}

/**
 * Remove the challenge from `holder[field]` and return it when it is still
 * fresh. Removed either way: a challenge is good for one answer.
 *
 * @returns {ChallengeRecord|null}
 */
function takeChallenge(holder, field, now = Date.now()) {
    if (!holder) return null;
    const record = holder[field];
    delete holder[field];
    if (!record || typeof record.challenge !== 'string' || typeof record.issuedAt !== 'number') return null;
    if (now - record.issuedAt >= CHALLENGE_TTL_MS || now < record.issuedAt) return null;
    return record;
}

/**
 * @param {{ response: any, record: ChallengeRecord }} args
 * @returns {Promise<{ ok: boolean, reason?: string, key?: { credentialId: string, publicKey: string,
 *   signCount: number, transports: string[], aaguid: string|null, backedUp: boolean } }>}
 *   `key` is set exactly when `ok` is; `reason` (for the log) exactly when it is not.
 */
async function verifyRegistration({ response, record }) {
    let result;
    try {
        result = await verifyRegistrationResponse({
            response,
            expectedChallenge: record.challenge,
            expectedOrigin: record.origin,
            expectedRPID: record.rpID,
            requireUserVerification: false,
        });
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    if (!result.verified) return { ok: false, reason: 'registration not verified' };
    const info = result.registrationInfo;
    return {
        ok: true,
        key: {
            credentialId: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
            signCount: info.credential.counter,
            transports: Array.isArray(info.credential.transports) ? info.credential.transports : [],
            aaguid: info.aaguid || null,
            backedUp: !!info.credentialBackedUp,
        },
    };
}

/**
 * The caller picks `key` by the response's credential id; the signature check
 * below is what proves the key actually signed. A counter that did not move
 * forward fails here too: that is how a cloned key shows itself.
 *
 * @param {{ response: any, record: ChallengeRecord, key: StoredKey }} args
 * @returns {Promise<{ ok: boolean, newCounter?: number, reason?: string }>}
 *   `newCounter` is set exactly when `ok` is; `reason` (for the log) exactly when it is not.
 */
async function verifyAuthentication({ response, record, key }) {
    let result;
    try {
        result = await verifyAuthenticationResponse({
            response,
            expectedChallenge: record.challenge,
            expectedOrigin: record.origin,
            expectedRPID: record.rpID,
            credential: {
                id: key.credentialId,
                publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')),
                counter: key.signCount,
                transports: key.transports,
            },
            requireUserVerification: false,
        });
    } catch (err) {
        return { ok: false, reason: err.message };
    }
    if (!result.verified) return { ok: false, reason: 'authentication not verified' };
    return { ok: true, newCounter: result.authenticationInfo.newCounter };
}

module.exports = {
    registrationOptions,
    authenticationOptions,
    challengeRecord,
    takeChallenge,
    verifyRegistration,
    verifyAuthentication,
    CHALLENGE_TTL_MS,
};
