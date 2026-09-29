/**
 * A software security key, for tests. It does what a YubiKey does on the wire:
 * an ES256 key pair per credential, authenticatorData with the RP ID hash, the
 * flags and a signature counter, and a 'none' attestation. The responses it
 * builds are the JSON shapes @simplewebauthn/browser hands the server, so a
 * test can run a ceremony end to end through the real verifier instead of a
 * stub that agrees with whatever the code under test expects.
 *
 * Every field a relay or a clone could get wrong is overridable: origin,
 * RP ID, challenge and counter.
 */

const crypto = require('crypto');
const { isoCBOR } = require('@simplewebauthn/server/helpers');

const FLAG_UP = 0x01; // user present (the touch)
const FLAG_AT = 0x40; // attested credential data follows

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const bytes = (buf) => new Uint8Array(buf);

function createSoftAuthenticator() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialId = crypto.randomBytes(32);
    const cosePublicKey = Buffer.from(isoCBOR.encode(new Map([
        [1, 2],   // kty: EC2
        [3, -7],  // alg: ES256
        [-1, 1],  // crv: P-256
        [-2, bytes(Buffer.from(String(jwk.x), 'base64url'))],
        [-3, bytes(Buffer.from(String(jwk.y), 'base64url'))],
    ])));
    let counter = 0;

    function authenticatorData(rpID, flags, count, attested) {
        const countBuf = Buffer.alloc(4);
        countBuf.writeUInt32BE(count);
        const parts = [sha256(rpID), Buffer.from([flags]), countBuf];
        if (attested) {
            const idLen = Buffer.alloc(2);
            idLen.writeUInt16BE(credentialId.length);
            parts.push(Buffer.alloc(16), idLen, credentialId, cosePublicKey);
        }
        return Buffer.concat(parts);
    }

    function clientData(type, challenge, origin) {
        return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    }

    return {
        credentialId: b64u(credentialId),

        /** Answer navigator.credentials.create() for these options. */
        register(options, { origin, rpID = options.rp.id, challenge = options.challenge } = {}) {
            const authData = authenticatorData(rpID, FLAG_UP | FLAG_AT, counter, true);
            const attestationObject = isoCBOR.encode(new Map([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', bytes(authData)],
            ]));
            return {
                id: b64u(credentialId),
                rawId: b64u(credentialId),
                type: 'public-key',
                response: {
                    clientDataJSON: b64u(clientData('webauthn.create', challenge, origin)),
                    attestationObject: b64u(attestationObject),
                    transports: ['nfc', 'usb'],
                },
                clientExtensionResults: {},
                authenticatorAttachment: 'cross-platform',
            };
        },

        /**
         * Answer navigator.credentials.get() for these options. Each answer
         * moves the counter forward unless `counterValue` pins it, which is how
         * a test plays a cloned key.
         */
        authenticate(options, { origin, rpID = options.rpId, challenge = options.challenge, counterValue } = {}) {
            counter = counterValue ?? counter + 1;
            const authData = authenticatorData(rpID, FLAG_UP, counter, false);
            const cData = clientData('webauthn.get', challenge, origin);
            const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(cData)]), privateKey);
            return {
                id: b64u(credentialId),
                rawId: b64u(credentialId),
                type: 'public-key',
                response: {
                    clientDataJSON: b64u(cData),
                    authenticatorData: b64u(authData),
                    signature: b64u(signature),
                },
                clientExtensionResults: {},
                authenticatorAttachment: 'cross-platform',
            };
        },
    };
}

module.exports = { createSoftAuthenticator };
