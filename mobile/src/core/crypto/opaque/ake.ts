/**
 * The 3DH authenticated key exchange layered on top of the envelope.
 *
 * Follows RFC 9807 §6.4 and the same construction in
 * `@cloudflare/opaque-ts` (`lib/src/common.js` — `expandLabel`, `deriveSecret`,
 * `preambleBuild`, `tripleDH_IKM`, `deriveKeys` — and `lib/src/3dh_client.js`).
 *
 * The one value that could not be read off either reference is the preamble's
 * leading literal: `@cloudflare/opaque-ts` uses `"RFCXXXX"` because it targets a
 * pre-publication draft. opaque-ke uses **`"OPAQUEv1-"`**, established by
 * replaying a real `loginResponse` from the reference server through this
 * derivation under each candidate (`"OPAQUEv1-"`, `"RFCXXXX"`, `"RFC9807"`,
 * `"OPAQUE-"`): only `"OPAQUEv1-"` reproduces the server MAC, and only the KE3
 * built from it is accepted by `server.finishLogin`.
 *
 * The context string is empty: @serenity-kit/opaque exposes no way to set one,
 * so it always serializes as `I2OSP(0, 2)`.
 */

import { extract, expand } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

import type { Identifiers } from './envelope';
import { diffieHellman, publicKeyFromScalar, randomScalar } from './oprf';
import { randomBytes, type RandomBytes } from './rng';
import {
    concatBytes,
    encodeVector16,
    i2osp1,
    i2osp2,
    SIZES,
    timingSafeEqual,
    utf8,
    wipe,
} from './serde';

/** opaque-ke's `STR_OPAQUE_VERSION`; the RFC 9807 preamble prefix. */
const PREAMBLE_VERSION = utf8('OPAQUEv1-');
/** opaque-ke's `STR_OPAQUE`; prefixed to every Expand-Label label. */
const EXPAND_LABEL_PREFIX = 'OPAQUE-';
/** @serenity-kit/opaque never sets a context, so it is always the empty vector. */
const EMPTY_CONTEXT = new Uint8Array(0);

const LABEL_HANDSHAKE_SECRET = 'HandshakeSecret';
const LABEL_SESSION_KEY = 'SessionKey';
const LABEL_SERVER_MAC = 'ServerMAC';
const LABEL_CLIENT_MAC = 'ClientMAC';

/**
 * RFC 9807 §6.4.1 Expand-Label, a TLS 1.3-shaped label:
 * `I2OSP(len,2) || vec8("OPAQUE-" || label) || vec8(context)`.
 */
function expandLabel(secret: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array {
    const qualified = utf8(EXPAND_LABEL_PREFIX + label);
    const customLabel = concatBytes(
        i2osp2(length),
        i2osp1(qualified.length),
        qualified,
        i2osp1(context.length),
        context,
    );
    return expand(sha512, secret, customLabel, length);
}

/** RFC 9807 §6.4.1 Derive-Secret. */
function deriveSecret(secret: Uint8Array, label: string, transcriptHash: Uint8Array): Uint8Array {
    return expandLabel(secret, label, transcriptHash, SIZES.HASH);
}

export interface Ke2Parts {
    readonly credentialResponse: Uint8Array;
    readonly serverNonce: Uint8Array;
    readonly serverKeyshare: Uint8Array;
    readonly serverMac: Uint8Array;
}

/**
 * RFC 9807 §6.4.2 Preamble. Every field the two sides must agree on, in one
 * buffer: version, context, identities, KE1, credential response, server nonce
 * and keyshare.
 */
export function buildPreamble(
    ke1: Uint8Array,
    ke2: Ke2Parts,
    clientIdentity: Uint8Array,
    serverIdentity: Uint8Array,
): Uint8Array {
    return concatBytes(
        PREAMBLE_VERSION,
        encodeVector16(EMPTY_CONTEXT),
        encodeVector16(clientIdentity),
        ke1,
        encodeVector16(serverIdentity),
        ke2.credentialResponse,
        ke2.serverNonce,
        ke2.serverKeyshare,
    );
}

/**
 * RFC 9807 §6.4.3, client side. The three Diffie-Hellmans, concatenated in the
 * order the server also computes them:
 * ephemeral·server-ephemeral, ephemeral·server-static, client-static·server-ephemeral.
 */
function tripleDhIkm(
    clientEphemeralPrivateKey: Uint8Array,
    clientStaticPrivateKey: Uint8Array,
    serverKeyshare: Uint8Array,
    serverPublicKey: Uint8Array,
): Uint8Array {
    const dh1 = diffieHellman(clientEphemeralPrivateKey, serverKeyshare);
    const dh2 = diffieHellman(clientEphemeralPrivateKey, serverPublicKey);
    const dh3 = diffieHellman(clientStaticPrivateKey, serverKeyshare);
    const ikm = concatBytes(dh1, dh2, dh3);
    wipe(dh1, dh2, dh3);
    return ikm;
}

interface SessionKeys {
    readonly km2: Uint8Array;
    readonly km3: Uint8Array;
    readonly sessionKey: Uint8Array;
}

/** RFC 9807 §6.4.4 DeriveKeys. */
function deriveKeys(ikm: Uint8Array, preamble: Uint8Array): SessionKeys {
    const prk = extract(sha512, ikm, new Uint8Array(0));
    const transcriptHash = sha512(preamble);
    const handshakeSecret = deriveSecret(prk, LABEL_HANDSHAKE_SECRET, transcriptHash);
    const sessionKey = deriveSecret(prk, LABEL_SESSION_KEY, transcriptHash);
    const noTranscript = new Uint8Array(0);
    const km2 = deriveSecret(handshakeSecret, LABEL_SERVER_MAC, noTranscript);
    const km3 = deriveSecret(handshakeSecret, LABEL_CLIENT_MAC, noTranscript);
    wipe(prk, handshakeSecret);
    return { km2, km3, sessionKey };
}

export interface ClientAkeStart {
    readonly ephemeralPrivateKey: Uint8Array;
    readonly clientNonce: Uint8Array;
    readonly clientKeyshare: Uint8Array;
}

/** RFC 9807 §6.4.5 AuthClientStart — a fresh nonce and an ephemeral keypair. */
export function startClientAke(rng: RandomBytes = randomBytes): ClientAkeStart {
    const clientNonce = rng(SIZES.NONCE);
    const ephemeralPrivateKey = randomScalar(rng);
    return {
        ephemeralPrivateKey,
        clientNonce,
        clientKeyshare: publicKeyFromScalar(ephemeralPrivateKey),
    };
}

export interface ClientAkeFinish {
    readonly clientMac: Uint8Array;
    readonly sessionKey: Uint8Array;
}

/**
 * RFC 9807 §6.4.5 AuthClientFinalize.
 *
 * Returns `null` if the server MAC does not verify. In practice that means the
 * server proved it does not hold the registration record we authenticated
 * against — a different failure from a wrong password, but one the caller
 * surfaces the same way.
 */
export function finishClientAke(params: {
    readonly ke1: Uint8Array;
    readonly ke2: Ke2Parts;
    readonly clientIdentity: Uint8Array;
    readonly serverIdentity: Uint8Array;
    readonly clientEphemeralPrivateKey: Uint8Array;
    readonly clientStaticPrivateKey: Uint8Array;
    readonly serverPublicKey: Uint8Array;
}): ClientAkeFinish | null {
    const ikm = tripleDhIkm(
        params.clientEphemeralPrivateKey,
        params.clientStaticPrivateKey,
        params.ke2.serverKeyshare,
        params.serverPublicKey,
    );
    const preamble = buildPreamble(params.ke1, params.ke2, params.clientIdentity, params.serverIdentity);
    const { km2, km3, sessionKey } = deriveKeys(ikm, preamble);
    wipe(ikm);

    const transcriptHash = sha512(preamble);
    const expectedServerMac = hmac(sha512, km2, transcriptHash);
    const ok = timingSafeEqual(expectedServerMac, params.ke2.serverMac);
    wipe(km2, expectedServerMac);
    if (!ok) {
        wipe(km3, sessionKey);
        return null;
    }

    const clientMac = hmac(sha512, km3, sha512(concatBytes(preamble, params.ke2.serverMac)));
    wipe(km3);
    return { clientMac, sessionKey };
}

/** Resolve the identities the transcript is bound to, applying RFC 9807 defaults. */
export function resolveIdentities(
    identifiers: Identifiers | undefined,
    clientPublicKey: Uint8Array,
    serverPublicKey: Uint8Array,
): { clientIdentity: Uint8Array; serverIdentity: Uint8Array } {
    return {
        clientIdentity: identifiers?.client === undefined ? clientPublicKey : utf8(identifiers.client),
        serverIdentity: identifiers?.server === undefined ? serverPublicKey : utf8(identifiers.server),
    };
}
