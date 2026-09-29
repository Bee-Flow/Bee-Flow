/**
 * The ristretto255 half of the suite: the OPRF (RFC 9497) plus the raw group
 * operations the AKE needs.
 *
 * OPRF and key-exchange group are deliberately in one module because in this
 * suite they are literally the same group — opaque-ke instantiates
 * `KeGroup = OprfCs::Group = Ristretto255`, so a scalar produced by
 * `DeriveDiffieHellmanKeyPair` (an RFC 9497 DeriveKeyPair call) is the same kind
 * of object as an OPRF blind.
 *
 * Resolved empirically against @serenity-kit/opaque v1.1.0 (see
 * `opaque.interop.test.ts`):
 *
 *  - opaque-ke depends on the Rust `voprf` 0.5.0 crate, which implements final
 *    RFC 9497, **not** an earlier draft. Its context string is therefore
 *    `"OPRFV1-" || 0x00 || "-ristretto255-SHA512"` (base OPRF mode 0x00).
 *    `@noble/curves`' `ristretto255_oprf.oprf` builds exactly that string
 *    (`abstract/oprf.ts`, `getCtx`), so we use it directly instead of
 *    hand-rolling blind/finalize.
 *  - The AKE keypair uses `DeriveKeyPair(seed, "OPAQUE-DeriveDiffieHellmanKeyPair")`,
 *    the RFC 9807 label — *not* the `"OPAQUE-DeriveAuthKeyPair"` of the older
 *    drafts that `@cloudflare/opaque-ts` still targets.
 *
 * ## Points that arrive over the wire
 *
 * Everything this module deserializes — the OPRF evaluated element, the server
 * keyshare — is attacker-controlled: it reaches us from the network before any
 * MAC has been checked. Two rules follow, and both are enforced here rather than
 * left to the caller:
 *
 *  - **Reject the identity.** RFC 9497 §3.3 requires it for OPRF elements
 *    (`@noble/curves` does this for us in `finalize`), and the same reasoning
 *    applies to a Diffie-Hellman peer key: `Point.fromBytes` happily accepts the
 *    all-zero encoding, and multiplying it by any scalar yields the all-zero
 *    encoding, so a hostile `serverKeyshare` of 32 zero bytes would silently turn
 *    two of the three 3DH legs into a constant. (It does not by itself break
 *    authentication — the surviving leg still needs the server's static private
 *    key — but a degenerate keyshare has no honest reason to be on the wire.)
 *  - **Report failures as `OpaqueError`.** noble raises bare `Error`/`RangeError`
 *    from deep inside its point decoder; `finishLogin` documents `OpaqueError` as
 *    the type callers discriminate on, so every wire-decoding failure is
 *    translated here instead of escaping as an unrecognisable crypto-internal
 *    exception.
 */

import { ristretto255, ristretto255_oprf } from '@noble/curves/ed25519.js';

import { randomBytes, type RandomBytes } from './rng';
import { OpaqueError, SIZES, utf8, wipe } from './serde';

const Point = ristretto255.Point;
const Fn = Point.Fn;

type PointType = ReturnType<typeof Point.fromBytes>;

/** RFC 9807 §3.1: the label that separates the AKE keypair from the OPRF key. */
const DERIVE_DH_KEYPAIR_INFO = utf8('OPAQUE-DeriveDiffieHellmanKeyPair');

export interface BlindResult {
    /** Secret blinding scalar; must survive until the matching `finalize`. */
    readonly blind: Uint8Array;
    /** Blinded element sent to the server. */
    readonly blinded: Uint8Array;
}

export interface KeyPair {
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
}

/**
 * Adapts our `RandomBytes` to the shape noble expects (optional length, and a
 * buffer it owns). The copy also asserts the injected source returned the number
 * of bytes it was asked for, which a hand-written test RNG can easily get wrong.
 */
function toNobleRng(rng: RandomBytes): (bytesLength?: number) => Uint8Array<ArrayBuffer> {
    return (bytesLength?: number) => {
        const requested = bytesLength ?? SIZES.SCALAR;
        const out = new Uint8Array(requested);
        out.set(rng(requested));
        return out;
    };
}

/** RFC 9497 §3.3.1 Blind, base mode. */
export function blind(input: Uint8Array, rng: RandomBytes = randomBytes): BlindResult {
    const result = ristretto255_oprf.oprf.blind(input, toNobleRng(rng));
    return { blind: result.blind, blinded: result.blinded };
}

/**
 * RFC 9497 §3.3.1 Finalize, base mode:
 * `Hash(I2OSP(len(input),2) || input || I2OSP(len(unblinded),2) || unblinded || "Finalize")`.
 */
export function finalize(input: Uint8Array, blindScalar: Uint8Array, evaluated: Uint8Array): Uint8Array {
    try {
        return ristretto255_oprf.oprf.finalize(input, blindScalar, evaluated);
    } catch (cause) {
        // noble rejects a non-canonical encoding and (per RFC 9497 §3.3) the
        // identity element, but raises a bare Error/RangeError. The evaluated
        // element is the first attacker-controlled field of every credential
        // response, so translate it into the documented protocol error type.
        throw new OpaqueError('evaluated element: not a valid OPRF evaluation', { cause });
    }
}

/** RFC 9807 §3.1 DeriveDiffieHellmanKeyPair — the client's long-term AKE key. */
export function deriveDiffieHellmanKeyPair(seed: Uint8Array): KeyPair {
    if (seed.length !== SIZES.SEED) throw new OpaqueError('DeriveDiffieHellmanKeyPair: bad seed length');
    const keys = ristretto255_oprf.oprf.deriveKeyPair(seed, DERIVE_DH_KEYPAIR_INFO);
    return { privateKey: keys.secretKey, publicKey: keys.publicKey };
}

function bytesToScalar(bytes: Uint8Array, what: string): bigint {
    if (bytes.length !== SIZES.SCALAR) throw new OpaqueError(`${what}: bad scalar length`);
    let value = 0n;
    // ristretto255 scalars are little-endian (curve25519-dalek's `Scalar::to_bytes`,
    // and noble's `Fn.isLE === true`).
    for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0);
    return value;
}

/** A uniformly random non-zero scalar, used for the ephemeral AKE keyshare. */
export function randomScalar(rng: RandomBytes = randomBytes): Uint8Array {
    for (let attempt = 0; attempt < 8; attempt++) {
        // 64 bytes reduced mod the ~2^252 group order: bias below 2^-124, which is
        // how RFC 9497 §4.x and noble's own `randomScalar` handle this.
        const wide = rng(64);
        const value = Fn.create(bytesToScalar(wide.subarray(0, 32), 'randomScalar') +
            (bytesToScalar(wide.subarray(32), 'randomScalar') << 256n));
        wipe(wide);
        if (!Fn.is0(value)) return Fn.toBytes(value);
    }
    throw new OpaqueError('randomScalar: exhausted attempts');
}

/** `scalar * G` — recovers a public key from a private scalar. */
export function publicKeyFromScalar(privateKey: Uint8Array): Uint8Array {
    return Point.BASE.multiply(bytesToScalar(privateKey, 'privateKey')).toBytes();
}

/**
 * Decode a public key that arrived over the wire.
 *
 * Rejects a non-canonical encoding (noble already does) *and* the identity
 * element (noble does not, for plain points), and reports either as an
 * `OpaqueError` naming the field rather than as a bare noble `Error`.
 */
export function decodePublicKey(bytes: Uint8Array, what: string): PointType {
    if (bytes.length !== SIZES.PUBLIC_KEY) throw new OpaqueError(`${what}: bad public key length`);
    let point;
    try {
        point = Point.fromBytes(bytes);
    } catch (cause) {
        throw new OpaqueError(`${what}: not a canonical ristretto255 point`, { cause });
    }
    if (point.equals(Point.ZERO)) throw new OpaqueError(`${what}: identity element`);
    return point;
}

/** Assert that a wire-supplied public key is usable, discarding the decoded point. */
export function assertPublicKey(bytes: Uint8Array, what: string): void {
    decodePublicKey(bytes, what);
}

/**
 * One Diffie-Hellman: `scalar * point`, serialized. The peer key is validated
 * first (see the module header): a non-canonical encoding or the identity throws
 * `OpaqueError`, which can only come from a malformed server message, never from
 * a bad password.
 */
export function diffieHellman(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    return decodePublicKey(publicKey, 'diffieHellman').multiply(bytesToScalar(privateKey, 'privateKey')).toBytes();
}
