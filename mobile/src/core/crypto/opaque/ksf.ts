/**
 * The key-stretching function (KSF) applied to the OPRF output.
 *
 * RFC 9807 §3.4 leaves the KSF to the application. @serenity-kit/opaque wires
 * `CipherSuite::Ksf = argon2::Argon2` and, since v1.1.0, exposes a
 * `keyStretching` option that defaults to its `"memory-constrained"` preset.
 *
 * Every parameter below was measured, not read from a changelog:
 *
 *  - The preset was identified by replaying one fixed `(clientLoginState,
 *    loginResponse)` pair through the reference `client.finishLogin` under each
 *    named preset; only `"memory-constrained"` reproduced the default's
 *    exportKey. (`"rfc-recommended"` took 9.2 s, `"rfc-draft-recommended"` 2.8 s.)
 *  - Its numeric parameters were then confirmed by passing
 *    `{ "argon2id-custom": { iterations: 3, memory: 65536, parallelism: 4 } }`
 *    explicitly and getting a byte-identical exportKey.
 *  - The **salt is 16 zero bytes** (`argon2::RECOMMENDED_SALT_LEN` worth of
 *    zeros, as opaque-ke's `impl Ksf for Argon2` passes). Salts of 8 or 32 zero
 *    bytes both produce a different, non-matching randomized password.
 *  - Output length is Nh = 64, matching the SHA-512 OPRF output it replaces.
 *
 * Cost: measured at ~1.15 s per call in Node on a server-class box under V8.
 * Hermes has no optimising JIT and a phone CPU is slower again, so the pure-JS
 * figure on a mid-range device is several times that — seconds, on the critical
 * path of signing in. The client cannot make the work cheaper: it has to burn
 * exactly what the reference client burns or it derives a different key.
 *
 * So there are two implementations, and the fast one has to earn its place:
 *
 *   - `modules/beeflow-argon2` runs the reference C implementation through
 *     argon2kt. Tens of milliseconds.
 *   - `@noble/hashes` is the fallback, and remains the reference the interop
 *     suite tests.
 *
 * The native path is verified before it is trusted, ONCE per process, by
 * running both implementations over cheap parameters and comparing. A missing
 * module makes sign-in slow; a subtly wrong one would make it derive the wrong
 * key and fail with "invalid password", which is far worse and much harder to
 * diagnose. The self-check makes that outcome impossible to ship silently.
 */

import { argon2id, argon2idAsync } from '@noble/hashes/argon2.js';

import { SIZES } from './serde';
import { isNativeArgon2Available, nativeArgon2id } from '../../../../modules/beeflow-argon2';


/** Argon2id parameters of @serenity-kit/opaque's default `"memory-constrained"` preset. */
export const KSF_PARAMS = {
    /** `t` — iterations. */
    iterations: 3,
    /** `m` — memory cost in KiB (64 MiB). */
    memoryKiB: 65536,
    /** `p` — lanes. */
    parallelism: 4,
    /** Output length; Nh for SHA-512. */
    outputLength: SIZES.HASH,
} as const;

/** opaque-ke hashes with a fixed all-zero salt: the OPRF output is the entropy. */
const ZERO_SALT = new Uint8Array(16);

/**
 * How long the async variant may hold the JS thread before yielding. 20 ms keeps
 * a 60 fps UI from dropping more than one frame per slice.
 */
const ASYNC_TICK_MS = 20;

function options(): {
    t: number;
    m: number;
    p: number;
    dkLen: number;
} {
    return {
        t: KSF_PARAMS.iterations,
        m: KSF_PARAMS.memoryKiB,
        p: KSF_PARAMS.parallelism,
        dkLen: KSF_PARAMS.outputLength,
    };
}

/**
 * RFC 9807 §3.4 Stretch(), synchronous and pure JS.
 *
 * Kept for the interop tests, which need a deterministic, dependency-free path
 * that runs in Node. Application code should call `stretchAsync`.
 */
export function stretch(input: Uint8Array): Uint8Array {
    return argon2id(input, ZERO_SALT, options());
}

/** Cheap parameters for the self-check — around ten milliseconds in pure JS. */
const SELFTEST = { t: 1, m: 256, p: 4, dkLen: 32 } as const;
const SELFTEST_INPUT = new TextEncoder().encode('beeflow-argon2-selftest');

/**
 * Does the native module agree with the implementation the interop suite
 * validates?
 *
 * Resolved once and memoised. The parameters deliberately include p=4 so the
 * check exercises the parallelism mapping, which is the argument most likely to
 * be silently mistranslated across a bridge.
 */
let nativeTrusted: Promise<boolean> | null = null;

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string): Uint8Array {
    if (globalThis.atob) {
        const binary = globalThis.atob(value);
        return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }
    return new Uint8Array(Buffer.from(value, 'base64'));
}

async function canTrustNative(): Promise<boolean> {
    if (!isNativeArgon2Available) return false;
    if (nativeTrusted) return nativeTrusted;
    nativeTrusted = (async () => {
        try {
            const expected = argon2id(SELFTEST_INPUT, ZERO_SALT, { ...SELFTEST });
            const actual = await nativeArgon2id(toBase64(SELFTEST_INPUT), toBase64(ZERO_SALT), {
                iterations: SELFTEST.t,
                memoryKiB: SELFTEST.m,
                parallelism: SELFTEST.p,
                outputLength: SELFTEST.dkLen,
            });
            if (!actual) return false;
            const got = fromBase64(actual);
            if (got.length !== expected.length) return false;
            // Not constant-time on purpose: both sides are public values from a
            // fixed test input, and a mismatch is a configuration bug rather
            // than something an attacker can probe.
            return got.every((byte, i) => byte === expected[i]);
        } catch {
            return false;
        }
    })();
    return nativeTrusted;
}

/** For diagnostics — Settings → About reports which path a device is on. */
export async function argon2Backend(): Promise<'native' | 'javascript'> {
    return (await canTrustNative()) ? 'native' : 'javascript';
}

/**
 * Same function, yielding to the event loop between Argon2 blocks.
 *
 * `onProgress` matters more here than it looks. This is the slowest single
 * operation in the whole app by an order of magnitude, and it sits on the
 * critical path of signing in. Hermes has no optimising JIT, so a cost measured
 * near a second on a desktop V8 is plausibly several times that on a mid-range
 * phone. A sign-in button that appears to do nothing for that long reads as a
 * hang, and the user's response to a hang is to press it again.
 *
 * With a progress fraction the screen can show a determinate bar and say what
 * it is doing, which turns the same wait into something legible.
 */
export async function stretchAsync(
    input: Uint8Array,
    onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
    if (await canTrustNative()) {
        const params = options();
        const hash = await nativeArgon2id(toBase64(input), toBase64(ZERO_SALT), {
            iterations: params.t,
            memoryKiB: params.m,
            parallelism: params.p,
            outputLength: params.dkLen,
        });
        if (hash) {
            // Nothing to report incrementally — the native call is fast enough
            // that a bar would flash. Jump to done so a caller driving a
            // progress UI still sees it complete rather than hang at zero.
            onProgress?.(1);
            return fromBase64(hash);
        }
    }
    return argon2idAsync(input, ZERO_SALT, {
        ...options(),
        asyncTick: ASYNC_TICK_MS,
        ...(onProgress ? { onProgress } : {}),
    });
}
