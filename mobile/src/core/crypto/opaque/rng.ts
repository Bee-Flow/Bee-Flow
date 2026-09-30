/**
 * Entropy for the OPAQUE client.
 *
 * The protocol draws randomness in three places — the OPRF blind, the envelope
 * nonce, and the ephemeral AKE keyshare — and all three come from the app's one
 * audited source, `src/core/crypto/random.ts` (expo-crypto, Android `SecureRandom`
 * underneath). This module exists only to name the function type and to keep
 * that dependency visible in one place rather than in four.
 *
 * Injecting a deterministic generator for tests is done the way the rest of
 * `src/crypto` does it, with `__setRandomSourceForTests`; every function in this
 * package additionally takes an explicit `rng` argument, so a unit test can pin
 * one step without touching global state.
 */

import { randomBytes } from '../random';

/** Returns `length` fresh random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

export { randomBytes };
