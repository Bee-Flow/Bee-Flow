/**
 * Wire encoding and message framing for the OPAQUE messages this client
 * exchanges with the Bee Flow server (`server/auth/opaqueRoutes.js`).
 *
 * The server speaks `@serenity-kit/opaque` v1.1.0, a wasm-bindgen wrapper around
 * the Rust `opaque-ke` crate. Two things about that wrapper are load-bearing and
 * were established by probing the real library rather than read from a spec:
 *
 *  1. Every message on the wire is **base64url without padding** (Rust's
 *     `base64::engine::general_purpose::URL_SAFE_NO_PAD`). Feeding it standard
 *     base64 makes it reject the input with `Invalid symbol 43` (`'+'`). We
 *     therefore always *emit* base64url-nopad, and *accept* either alphabet with
 *     or without padding, since being liberal on input costs nothing.
 *  2. The struct layout below is opaque-ke's, which follows RFC 9807 §6 for the
 *     ristretto255-SHA512 suite (Noe = Npk = Nsk = Nn = Nseed = 32, Nh = Nm = 64).
 *
 * Structure and the length-prefixed vector helpers follow the readable reference
 * implementation of the same RFC in `@cloudflare/opaque-ts` (`lib/src/util.js`,
 * `lib/src/messages.js`); only the suite parameters differ.
 */

/** Byte lengths of the ristretto255-SHA512 suite, per RFC 9807 §6.4. */
export const SIZES = {
    /** Noe — serialized ristretto255 element. */
    ELEMENT: 32,
    /** Nsk / Npk — ristretto255 scalar and public key. */
    SCALAR: 32,
    PUBLIC_KEY: 32,
    /** Nn — protocol nonces (envelope, masking, client, server). */
    NONCE: 32,
    /** Nseed — seed handed to DeriveDiffieHellmanKeyPair. */
    SEED: 32,
    /** Nh — SHA-512 output. */
    HASH: 64,
    /** Nm — HMAC-SHA-512 tag. */
    MAC: 64,
} as const;

/** Ne — envelope is `nonce || auth_tag`. */
export const ENVELOPE_SIZE = SIZES.NONCE + SIZES.MAC;
/** The masked half of a credential response: `server_public_key || envelope`. */
export const MASKED_RESPONSE_SIZE = SIZES.PUBLIC_KEY + ENVELOPE_SIZE;

export const REGISTRATION_REQUEST_SIZE = SIZES.ELEMENT;
export const REGISTRATION_RESPONSE_SIZE = SIZES.ELEMENT + SIZES.PUBLIC_KEY;
export const REGISTRATION_RECORD_SIZE = SIZES.PUBLIC_KEY + SIZES.HASH + ENVELOPE_SIZE;
/** KE1 — `credential_request || client_nonce || client_keyshare`. */
export const KE1_SIZE = SIZES.ELEMENT + SIZES.NONCE + SIZES.PUBLIC_KEY;
/** CredentialResponse — `evaluated_element || masking_nonce || masked_response`. */
export const CREDENTIAL_RESPONSE_SIZE = SIZES.ELEMENT + SIZES.NONCE + MASKED_RESPONSE_SIZE;
/** KE2 — `credential_response || server_nonce || server_keyshare || server_mac`. */
export const KE2_SIZE = CREDENTIAL_RESPONSE_SIZE + SIZES.NONCE + SIZES.PUBLIC_KEY + SIZES.MAC;
/** KE3 — bare client MAC. */
export const KE3_SIZE = SIZES.MAC;

/**
 * Thrown for structurally invalid input; a wrong *password* is never an error.
 *
 * This is the one error type this package raises, and the type callers are
 * expected to discriminate on — a `loginResponse` is attacker-controlled, so
 * failures from the underlying primitives are translated into this rather than
 * escaping as a bare noble `Error`. `cause` carries the original where there is
 * one, for logs; the message never contains key material.
 */
export class OpaqueError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'OpaqueError';
    }
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** I2OSP(n, 1). */
export function i2osp1(n: number): Uint8Array {
    if (n < 0 || n > 0xff) throw new OpaqueError(`i2osp1 out of range: ${n}`);
    return Uint8Array.of(n);
}

/** I2OSP(n, 2), big-endian — the length prefix used throughout RFC 9807. */
export function i2osp2(n: number): Uint8Array {
    if (n < 0 || n > 0xffff) throw new OpaqueError(`i2osp2 out of range: ${n}`);
    return Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
}

/** `opaque field<0..2^16-1>` — a 2-byte length followed by the payload. */
export function encodeVector16(payload: Uint8Array): Uint8Array {
    return concatBytes(i2osp2(payload.length), payload);
}

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 encode. Identities and labels are compared as bytes, never as strings. */
export function utf8(text: string): Uint8Array {
    return TEXT_ENCODER.encode(text);
}

export function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length !== b.length) throw new OpaqueError('xor: length mismatch');
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
    return out;
}

/**
 * Constant-time byte comparison. MAC verification must not leak *where* two tags
 * diverge, so this always walks the whole buffer and never short-circuits — the
 * length check up front is fine because message lengths are public.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length || a.length === 0) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
}

/**
 * Best-effort erasure of key material.
 *
 * This only clears the specific buffers we hold. JS gives us no way to reach
 * copies the engine made (bigint limbs inside noble's scalar arithmetic, strings
 * produced by base64 encoding, values spilled by Hermes' GC), so treat this as
 * shortening a window rather than as a guarantee.
 */
export function wipe(...buffers: readonly (Uint8Array | undefined)[]): void {
    for (const buffer of buffers) buffer?.fill(0);
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url, no padding — hand-rolled because Hermes ships neither `btoa` nor
 * `Buffer`, and a React Native polyfill would only give us the standard alphabet.
 *
 * Deliberately NOT the `toBase64`/`fromBase64` pair in `src/core/crypto/keys.ts`:
 * those are standard-alphabet-with-padding, which is right for the envelope
 * fields they encode and wrong here — opaque-ke rejects `+` outright. Note the
 * consequence for anything consuming `exportKey`: the reference library returns
 * it in *this* dialect, so a standard-alphabet decoder will reject it.
 */
export function toBase64Url(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1] ?? 0;
        const b2 = bytes[i + 2] ?? 0;
        const remaining = bytes.length - i;
        out += B64URL_ALPHABET[b0 >>> 2];
        out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >>> 4)];
        if (remaining > 1) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >>> 6)];
        if (remaining > 2) out += B64URL_ALPHABET[b2 & 0x3f];
    }
    return out;
}

const B64_DECODE = (() => {
    const table = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64URL_ALPHABET.length; i++) table[B64URL_ALPHABET.charCodeAt(i)] = i;
    // Accept the standard alphabet too: the protocol only ever emits base64url,
    // but a value that has round-tripped through some other encoder should still
    // decode rather than fail deep inside the protocol.
    table['+'.charCodeAt(0)] = 62;
    table['/'.charCodeAt(0)] = 63;
    return table;
})();

export function fromBase64(text: string, what = 'value'): Uint8Array {
    const digits = base64Digits(text, what);
    if (digits.length % 4 === 1) throw new OpaqueError(`${what}: truncated base64`);
    const out = new Uint8Array((digits.length * 3) >>> 2);
    let o = 0;
    for (let i = 0; i < digits.length; i += 4) {
        const d0 = digits[i] ?? 0;
        const d1 = digits[i + 1] ?? 0;
        const d2 = digits[i + 2] ?? 0;
        const d3 = digits[i + 3] ?? 0;
        const chunk = (d0 << 18) | (d1 << 12) | (d2 << 6) | d3;
        if (o < out.length) out[o++] = (chunk >>> 16) & 0xff;
        if (o < out.length) out[o++] = (chunk >>> 8) & 0xff;
        if (o < out.length) out[o++] = chunk & 0xff;
    }
    return out;
}

/** The 6-bit digits of a base64(url) string, padding skipped; throws on a stray character. */
function base64Digits(text: string, what: string): number[] {
    const digits: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 0x3d) continue; // '=' padding, optional in this dialect
        const digit = code < 128 ? (B64_DECODE[code] ?? -1) : -1;
        if (digit < 0) throw new OpaqueError(`${what}: not valid base64`);
        digits.push(digit);
    }
    return digits;
}

/** Decode base64 and assert the exact length the suite mandates. */
export function decodeFixed(text: string, size: number, what: string): Uint8Array {
    const bytes = fromBase64(text, what);
    if (bytes.length !== size) {
        throw new OpaqueError(`${what}: expected ${size} bytes, got ${bytes.length}`);
    }
    return bytes;
}

/** Cursor over a fixed-layout message; every field length is a suite constant. */
export class ByteReader {
    private offset = 0;

    constructor(
        private readonly bytes: Uint8Array,
        private readonly what: string,
    ) {}

    take(size: number): Uint8Array {
        if (this.offset + size > this.bytes.length) {
            throw new OpaqueError(`${this.what}: ran out of bytes`);
        }
        const slice = this.bytes.slice(this.offset, this.offset + size);
        this.offset += size;
        return slice;
    }
}
