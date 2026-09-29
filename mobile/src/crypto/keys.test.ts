/**
 * Differential test: this port against the web implementation it replaces.
 *
 * The reference is not a fixture file — it is agent-hub/src/lib/opaque.js's
 * algorithm re-expressed here on Node's WebCrypto, which is the SAME API the
 * browser runs. So the assertions below compare @noble output against
 * WebCrypto output for the same inputs, which is exactly the property that
 * matters: a vault wrapped in the browser must open on the phone and vice
 * versa. A hard-coded fixture would only prove this port is self-consistent.
 */

import { webcrypto } from 'node:crypto';

import {
    deriveKEK,
    encryptDEKForServer,
    fromBase64,
    fromHex,
    generateRecoveryKey,
    parseRecoveryKey,
    toBase64,
    toHex,
    unwrapDEK,
    wrapDEK,
    type WrappedKey,
} from './keys';
import { __setRandomSourceForTests } from './random';

/**
 * Node's webcrypto types are structurally the same as the DOM's but nominally
 * distinct (Node's KeyUsage union has post-quantum members the DOM lib does
 * not). The cast is to the DOM shape the browser code is written against —
 * which is the whole point of the comparison — rather than to `any`.
 */
const nodeCrypto = webcrypto as unknown as Crypto;
const subtle = nodeCrypto.subtle;
const encoder = new TextEncoder();

/** Uint8Array<ArrayBufferLike> -> the Uint8Array<ArrayBuffer> WebCrypto wants. */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return bytes as Uint8Array<ArrayBuffer>;
}

// ── The web implementation, verbatim in behaviour ────────────────────────────

async function webDeriveKEK(exportKeyB64: string): Promise<CryptoKey> {
    const keyMaterial = buf(Uint8Array.from(Buffer.from(exportKeyB64, 'base64')));
    const imported = await subtle.importKey('raw', keyMaterial, { name: 'HKDF' }, false, [
        'deriveKey',
    ]);
    return subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode('beeflow:opaque:kek:v1'),
            info: encoder.encode('beeflow:opaque:kek-derive'),
        },
        imported,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
}

async function webWrapDEK(dek: Uint8Array, key: CryptoKey, context: string): Promise<WrappedKey> {
    const iv = nodeCrypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
    const ciphertext = new Uint8Array(
        await subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 },
            key,
            buf(dek),
        ),
    );
    return {
        iv: toHex(iv),
        authTag: toHex(ciphertext.slice(ciphertext.length - 16)),
        data: toHex(ciphertext.slice(0, ciphertext.length - 16)),
    };
}

async function webUnwrapDEK(
    wrapped: WrappedKey,
    key: CryptoKey,
    context: string,
): Promise<Uint8Array> {
    const data = fromHex(wrapped.data);
    const tag = fromHex(wrapped.authTag);
    const combined = new Uint8Array(data.length + tag.length);
    combined.set(data);
    combined.set(tag, data.length);
    return new Uint8Array(
        await subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: buf(fromHex(wrapped.iv)),
                additionalData: encoder.encode(context),
                tagLength: 128,
            },
            key,
            buf(combined),
        ),
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

const EXPORT_KEY = Buffer.from(
    Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 13) & 0xff),
).toString('base64');

describe('hex and base64 helpers', () => {
    it('round-trips every byte value', () => {
        const all = Uint8Array.from({ length: 256 }, (_, i) => i);
        expect(fromHex(toHex(all))).toEqual(all);
        expect(fromBase64(toBase64(all))).toEqual(all);
    });

    it('agrees with Node Buffer on base64, including padding', () => {
        for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64]) {
            const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff);
            expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
            expect(fromBase64(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
        }
    });

    /**
     * The regression this pins: src/crypto/opaque emits base64url without
     * padding (opaque-ke accepts nothing else), and its exportKey/sessionKey
     * are fed straight into deriveKEK and encryptDEKForServer. A
     * standard-alphabet-only decoder here rejects any value containing '-' or
     * '_' — which is very nearly every sign-in — so the whole login path
     * depends on this accepting both dialects.
     */
    it('decodes base64url, which is what the OPAQUE module emits', () => {
        const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 97 + 11) & 0xff);
        const standard = Buffer.from(bytes).toString('base64');
        const url = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        // The fixture has to actually exercise the substitution, or it proves
        // nothing.
        expect(url).toMatch(/[-_]/);
        expect(fromBase64(url)).toEqual(bytes);
        expect(fromBase64(standard)).toEqual(bytes);
    });

    it('rejects malformed input rather than returning wrong bytes', () => {
        expect(() => fromHex('abc')).toThrow(/odd length/i);
        expect(() => fromHex('zz')).toThrow(/non-hex/i);
        expect(() => fromBase64('!!!!')).toThrow(/malformed/i);
    });
});

describe('deriveKEK', () => {
    it('matches WebCrypto HKDF-SHA256 with the app salt and info', async () => {
        const mine = deriveKEK(EXPORT_KEY);
        const theirs = new Uint8Array(await subtle.exportKey('raw', await webDeriveKEK(EXPORT_KEY)));
        expect(toHex(mine)).toBe(toHex(theirs));
        expect(mine).toHaveLength(32);
    });

    it('produces a different KEK for a different exportKey', () => {
        const other = Buffer.alloc(64, 1).toString('base64');
        expect(toHex(deriveKEK(EXPORT_KEY))).not.toBe(toHex(deriveKEK(other)));
    });
});

describe('DEK wrapping interoperates with WebCrypto', () => {
    const dek = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 3) & 0xff);
    const context = 'dek-wrap:tom@beeflow.nl';

    it('unwraps an envelope the browser produced', async () => {
        const webKey = await webDeriveKEK(EXPORT_KEY);
        const wrapped = await webWrapDEK(dek, webKey, context);
        expect(unwrapDEK(wrapped, deriveKEK(EXPORT_KEY), context)).toEqual(dek);
    });

    it('produces an envelope the browser can unwrap', async () => {
        const wrapped = wrapDEK(dek, deriveKEK(EXPORT_KEY), context);
        const webKey = await webDeriveKEK(EXPORT_KEY);
        expect(await webUnwrapDEK(wrapped, webKey, context)).toEqual(dek);
    });

    it('refuses an envelope wrapped under a different AAD context', () => {
        const wrapped = wrapDEK(dek, deriveKEK(EXPORT_KEY), context);
        expect(() => unwrapDEK(wrapped, deriveKEK(EXPORT_KEY), 'dek-wrap:someone-else')).toThrow();
    });

    it('refuses a tampered ciphertext', () => {
        const wrapped = wrapDEK(dek, deriveKEK(EXPORT_KEY), context);
        const bytes = fromHex(wrapped.data);
        bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
        expect(() => unwrapDEK({ ...wrapped, data: toHex(bytes) }, deriveKEK(EXPORT_KEY), context)).toThrow();
    });

    it('rejects a malformed envelope instead of throwing from deep inside AES', () => {
        expect(() => unwrapDEK({ iv: 'aa', authTag: 'bb', data: 'cc' }, deriveKEK(EXPORT_KEY), context)).toThrow(
            /bad IV length/i,
        );
    });
});

describe('encryptDEKForServer', () => {
    it('encrypts the base64 form of the DEK under the first 32 bytes of the session key', async () => {
        const dek = Uint8Array.from({ length: 32 }, (_, i) => i);
        const sessionKey = Buffer.from(
            Uint8Array.from({ length: 64 }, (_, i) => (i * 5 + 1) & 0xff),
        ).toString('base64');

        const sealed = encryptDEKForServer(dek, sessionKey);

        // Decrypt the way the server does: AES-GCM, no AAD, key = first 32 bytes.
        const rawKey = buf(Uint8Array.from(Buffer.from(sessionKey, 'base64')).slice(0, 32));
        const key = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
        const data = fromHex(sealed.data);
        const tag = fromHex(sealed.authTag);
        const combined = new Uint8Array(data.length + tag.length);
        combined.set(data);
        combined.set(tag, data.length);
        const plaintext = new Uint8Array(
            await subtle.decrypt(
                { name: 'AES-GCM', iv: buf(fromHex(sealed.iv)), tagLength: 128 },
                key,
                buf(combined),
            ),
        );
        // The plaintext is the DEK as BASE64 TEXT, not the raw key bytes.
        expect(new TextDecoder().decode(plaintext)).toBe(toBase64(dek));
    });
});

describe('recovery keys', () => {
    it('formats as eight uppercase hex groups and parses back', () => {
        const { raw, formatted } = generateRecoveryKey();
        expect(formatted).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{8}){7}$/);
        expect(parseRecoveryKey(formatted)).toEqual(raw);
    });

    it('accepts what a person actually types', () => {
        const { raw, formatted } = generateRecoveryKey();
        expect(parseRecoveryKey(formatted.toLowerCase())).toEqual(raw);
        expect(parseRecoveryKey(formatted.replace(/-/g, ' '))).toEqual(raw);
        expect(parseRecoveryKey(`  ${formatted}  `)).toEqual(raw);
    });

    it('rejects a truncated key rather than deriving a weak one', () => {
        expect(() => parseRecoveryKey('ABCD1234')).toThrow(/recovery key/i);
    });
});

describe('randomness', () => {
    it('uses the injected source, and restores it', () => {
        const restore = __setRandomSourceForTests((target) => target.fill(0xab));
        try {
            const { raw } = generateRecoveryKey();
            expect(toHex(raw)).toBe('ab'.repeat(32));
        } finally {
            restore();
        }
        // Two keys generated from the real source must differ.
        expect(generateRecoveryKey().formatted).not.toBe(generateRecoveryKey().formatted);
    });
});
