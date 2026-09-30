/**
 * The OPAQUE envelope: how a password becomes a private key, and how the server
 * hands that key back without learning anything.
 *
 * Follows RFC 9807 §4 (`Store`, `Recover`, `CreateCleartextCredentials`) and
 * mirrors the structure of `@cloudflare/opaque-ts`' `lib/src/core_client.js`,
 * with this suite's SHA-512 sizes and opaque-ke's KSF.
 *
 * Empirically resolved against @serenity-kit/opaque v1.1.0:
 *
 *  - `randomized_password = Extract("", oprf_output || Stretch(oprf_output))`.
 *    Both operands are present and in that order: `Extract("", Stretch(...))`
 *    alone, and the reversed concatenation, produce a masking key that fails to
 *    unmask a genuine credential response. (opaque-ke has shipped both shapes
 *    across major versions, so this one had to be pinned.)
 *  - `CleartextCredentials = server_public_key || vec16(server_identity) ||
 *    vec16(client_identity)` — server identity first. The reverse order and an
 *    unprefixed concatenation both fail the envelope MAC.
 *  - When no identifiers are supplied, `server_identity` defaults to the
 *    *server public key* and `client_identity` to the *client public key* —
 *    not to empty strings. Verified in both directions: a run with explicit
 *    identifiers and a run without both reproduce the reference auth tag.
 */

import { extract, expand } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

import { deriveDiffieHellmanKeyPair, type KeyPair } from './oprf';
import { randomBytes, type RandomBytes } from './rng';
import {
    ByteReader,
    concatBytes,
    encodeVector16,
    ENVELOPE_SIZE,
    MASKED_RESPONSE_SIZE,
    OpaqueError,
    SIZES,
    timingSafeEqual,
    utf8,
    wipe,
    xor,
} from './serde';

/** Optional application identities bound into the envelope and the transcript. */
export interface Identifiers {
    readonly client?: string;
    readonly server?: string;
}

const LABEL_AUTH_KEY = utf8('AuthKey');
const LABEL_EXPORT_KEY = utf8('ExportKey');
const LABEL_PRIVATE_KEY = utf8('PrivateKey');
const LABEL_MASKING_KEY = utf8('MaskingKey');
const LABEL_CREDENTIAL_RESPONSE_PAD = utf8('CredentialResponsePad');

/** HKDF-Extract with an empty salt, as RFC 9807 specifies for this step. */
const NO_SALT = new Uint8Array(0);

export interface Envelope {
    readonly nonce: Uint8Array;
    readonly authTag: Uint8Array;
}

export function serializeEnvelope(envelope: Envelope): Uint8Array {
    return concatBytes(envelope.nonce, envelope.authTag);
}

/** RFC 9807 §3.4: fold the stretched and unstretched OPRF outputs into one PRK. */
export function deriveRandomizedPassword(oprfOutput: Uint8Array, stretched: Uint8Array): Uint8Array {
    return extract(sha512, concatBytes(oprfOutput, stretched), NO_SALT);
}

/** RFC 9807 §4.1.2: the key the server uses to mask its credential response. */
export function deriveMaskingKey(randomizedPassword: Uint8Array): Uint8Array {
    return expand(sha512, randomizedPassword, LABEL_MASKING_KEY, SIZES.HASH);
}

interface EnvelopeKeys {
    readonly authKey: Uint8Array;
    readonly exportKey: Uint8Array;
    readonly clientKeyPair: KeyPair;
}

/** RFC 9807 §4.1.1 — everything the envelope nonce unlocks. */
function expandKeys(randomizedPassword: Uint8Array, nonce: Uint8Array): EnvelopeKeys {
    const authKey = expand(sha512, randomizedPassword, concatBytes(nonce, LABEL_AUTH_KEY), SIZES.HASH);
    const exportKey = expand(sha512, randomizedPassword, concatBytes(nonce, LABEL_EXPORT_KEY), SIZES.HASH);
    const seed = expand(sha512, randomizedPassword, concatBytes(nonce, LABEL_PRIVATE_KEY), SIZES.SEED);
    const clientKeyPair = deriveDiffieHellmanKeyPair(seed);
    wipe(seed);
    return { authKey, exportKey, clientKeyPair };
}

/** RFC 9807 §4: CreateCleartextCredentials, with public keys as identity defaults. */
export function cleartextCredentials(
    serverPublicKey: Uint8Array,
    clientPublicKey: Uint8Array,
    identifiers: Identifiers | undefined,
): Uint8Array {
    const serverIdentity = identifiers?.server === undefined ? serverPublicKey : utf8(identifiers.server);
    const clientIdentity = identifiers?.client === undefined ? clientPublicKey : utf8(identifiers.client);
    return concatBytes(serverPublicKey, encodeVector16(serverIdentity), encodeVector16(clientIdentity));
}

export interface StoreResult {
    readonly envelope: Envelope;
    readonly clientPublicKey: Uint8Array;
    readonly maskingKey: Uint8Array;
    readonly exportKey: Uint8Array;
}

/** RFC 9807 §4.1.2 Store — the registration half. */
export function store(
    randomizedPassword: Uint8Array,
    serverPublicKey: Uint8Array,
    identifiers: Identifiers | undefined,
    rng: RandomBytes = randomBytes,
): StoreResult {
    const nonce = rng(SIZES.NONCE);
    const { authKey, exportKey, clientKeyPair } = expandKeys(randomizedPassword, nonce);
    const credentials = cleartextCredentials(serverPublicKey, clientKeyPair.publicKey, identifiers);
    const authTag = hmac(sha512, authKey, concatBytes(nonce, credentials));
    wipe(authKey, clientKeyPair.privateKey);
    return {
        envelope: { nonce, authTag },
        clientPublicKey: clientKeyPair.publicKey,
        maskingKey: deriveMaskingKey(randomizedPassword),
        exportKey,
    };
}

export interface RecoverResult {
    readonly clientKeyPair: KeyPair;
    readonly exportKey: Uint8Array;
}

/**
 * RFC 9807 §4.1.3 Recover.
 *
 * Returns `null` — never throws — when the auth tag does not verify. That is the
 * *only* signal a wrong password produces anywhere in this protocol, and callers
 * up to `finishLogin` propagate it as `null` rather than as an exception.
 */
export function recover(
    randomizedPassword: Uint8Array,
    envelope: Envelope,
    serverPublicKey: Uint8Array,
    identifiers: Identifiers | undefined,
): RecoverResult | null {
    const { authKey, exportKey, clientKeyPair } = expandKeys(randomizedPassword, envelope.nonce);
    const credentials = cleartextCredentials(serverPublicKey, clientKeyPair.publicKey, identifiers);
    const expected = hmac(sha512, authKey, concatBytes(envelope.nonce, credentials));
    const ok = timingSafeEqual(expected, envelope.authTag);
    wipe(authKey, expected);
    if (!ok) {
        wipe(exportKey, clientKeyPair.privateKey);
        return null;
    }
    return { clientKeyPair, exportKey };
}

export interface UnmaskedResponse {
    readonly serverPublicKey: Uint8Array;
    readonly envelope: Envelope;
}

/**
 * RFC 9807 §6.2.2: undo the server's masking of `server_public_key || envelope`.
 *
 * With a wrong password this yields uniformly random bytes rather than failing —
 * which is the point of masking. Nothing here parses those bytes as a curve
 * point; that only happens after `recover()` has authenticated them.
 */
export function unmaskResponse(
    randomizedPassword: Uint8Array,
    maskingNonce: Uint8Array,
    maskedResponse: Uint8Array,
): UnmaskedResponse {
    if (maskedResponse.length !== MASKED_RESPONSE_SIZE) {
        throw new OpaqueError('credential response: bad masked_response length');
    }
    const maskingKey = deriveMaskingKey(randomizedPassword);
    const pad = expand(
        sha512,
        maskingKey,
        concatBytes(maskingNonce, LABEL_CREDENTIAL_RESPONSE_PAD),
        MASKED_RESPONSE_SIZE,
    );
    const plain = xor(pad, maskedResponse);
    wipe(maskingKey, pad);

    const reader = new ByteReader(plain, 'credential response');
    const serverPublicKey = reader.take(SIZES.PUBLIC_KEY);
    const nonce = reader.take(SIZES.NONCE);
    const authTag = reader.take(SIZES.MAC);
    wipe(plain);
    return { serverPublicKey, envelope: { nonce, authTag } };
}

export { ENVELOPE_SIZE };
