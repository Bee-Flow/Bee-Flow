/**
 * The one entropy source.
 *
 * Hermes has no `crypto.getRandomValues`, so every random byte in the app comes
 * through here — expo-crypto, which is Android's `SecureRandom` underneath.
 * Routing it through one module means a test can substitute a deterministic
 * generator without any call site knowing, and means there is exactly one place
 * to audit when someone asks where the DEK's randomness comes from.
 */

import * as Crypto from 'expo-crypto';

type RandomFill = (target: Uint8Array) => Uint8Array;

const secure: RandomFill = (target) => Crypto.getRandomValues(target);

let source: RandomFill = secure;

export function randomBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length <= 0) {
        throw new Error(`randomBytes: invalid length ${length}`);
    }
    return source(new Uint8Array(length));
}

/**
 * Swap the generator. FOR TESTS ONLY — a deterministic RNG in production would
 * make every key in the app guessable, so this is deliberately noisy to call
 * and returns a restore function rather than leaving the override in place.
 */
export function __setRandomSourceForTests(fn: RandomFill): () => void {
    const previous = source;
    source = fn;
    return () => {
        source = previous;
    };
}
