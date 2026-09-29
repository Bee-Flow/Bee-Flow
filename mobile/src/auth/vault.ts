/**
 * The data encryption key's life on the device.
 *
 * Bee Flow is zero-knowledge: the DEK is derived from the user's password on
 * the client and the server only ever holds it wrapped (or, for the duration
 * of a session, encrypted under the OPAQUE session key so the backend can run
 * AI over the user's own data).
 *
 * Be careful about what that second case means, because this comment used to
 * get it wrong in a way that made this module sound load-bearing when it is
 * not. It claimed the web's key "lives in a tab and dies with it". It does not:
 * the browser derives the DEK, encrypts it to the server and throws its own
 * copy away, and the key then lives in `req.session.encryptionKey` — serialised
 * into the Postgres session row, for the cookie's full thirty days. The mobile
 * app does exactly the same thing at sign-in.
 *
 * So a surviving session can already read the user's data with nothing held on
 * the phone, and this module is NOT what stands between a stolen handset and
 * plaintext. What it decides is narrower and worth stating honestly: whether
 * this device keeps a local copy of the key, and therefore whether the app can
 * put a lock screen of its own in front of a session that is otherwise valid.
 *
 * The default is: NOTHING is kept. A cold start does not prompt for anything —
 * the session carries it — and the lock screen only appears for someone who
 * turned the app lock on.
 *
 * The opt-in (`keepUnlocked = true`) puts the DEK in expo-secure-store with
 * `requireAuthentication: true`, which on Android means an AES key in the
 * hardware Keystore, released only after a biometric or device-credential
 * prompt, and invalidated by the OS if the user enrols a new fingerprint. That
 * is a genuine security boundary rather than a convenience flag — but it is
 * still a boundary the device holds, so the setting screen says so plainly
 * instead of calling it "remember me".
 */

import * as SecureStore from 'expo-secure-store';

import { scrub } from '../crypto/keys';

/** Namespaced so a future second account on one device cannot collide. */
const DEK_KEY = 'beeflow.vault.dek';
const OWNER_KEY = 'beeflow.vault.owner';

let memoryDek: string | null = null;

export interface VaultState {
    /** True when a DEK is available right now, in memory. */
    unlocked: boolean;
    /** True when a DEK is stored behind biometrics for the next cold start. */
    persisted: boolean;
}

/** The DEK for this session, base64, or null when the vault is locked. */
export function getDek(): string | null {
    return memoryDek;
}

export function setDek(dek: string | null): void {
    memoryDek = dek;
}

/** Forget the in-memory key. Called on sign-out, and on app lock. */
export function lock(): void {
    memoryDek = null;
}

/**
 * Can this device hold a key behind biometrics at all?
 *
 * Returns false on a device with no enrolled biometric or screen lock — where
 * `requireAuthentication` storage is not available, and offering the option
 * would be offering something that silently degrades to unprotected storage.
 */
export async function canPersist(): Promise<boolean> {
    try {
        return await SecureStore.canUseBiometricAuthentication();
    } catch {
        return false;
    }
}

/**
 * Persist the DEK behind a biometric prompt, tagged with the user it belongs
 * to. The owner tag is stored WITHOUT authentication so a cold start can find
 * out whether there is anything to unlock before prompting — asking for a
 * fingerprint and then discovering the stored key belongs to a different
 * account would be a poor first impression.
 */
export async function persist(userId: string, dek: string): Promise<void> {
    await SecureStore.setItemAsync(OWNER_KEY, userId);
    await SecureStore.setItemAsync(DEK_KEY, dek, {
        requireAuthentication: true,
        authenticationPrompt: 'Unlock Bee Flow',
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
}

/** Who the stored key belongs to, or null when nothing is stored. */
export async function persistedOwner(): Promise<string | null> {
    try {
        return await SecureStore.getItemAsync(OWNER_KEY);
    } catch {
        return null;
    }
}

/**
 * Prompt for biometrics and load the stored DEK into memory.
 *
 * Returns false when the user cancels or authentication fails — which is a
 * normal outcome, not an error, so the caller shows the password screen rather
 * than an alert.
 */
export async function unlockWithBiometrics(): Promise<boolean> {
    try {
        const dek = await SecureStore.getItemAsync(DEK_KEY, {
            requireAuthentication: true,
            authenticationPrompt: 'Unlock Bee Flow',
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        if (!dek) {
            // The OS answers null once biometrics changed and invalidated the
            // key; there is nothing left to unlock with, so stop asking.
            await forget();
            return false;
        }
        memoryDek = dek;
        return true;
    } catch {
        // A cancelled prompt or a transient keystore error: the key is still
        // there, so it stays for the next attempt.
        return false;
    }
}

/** Remove any persisted key. Called on sign-out and when the user opts out. */
export async function forget(): Promise<void> {
    memoryDek = null;
    await Promise.allSettled([
        SecureStore.deleteItemAsync(DEK_KEY, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
        SecureStore.deleteItemAsync(OWNER_KEY),
    ]);
}

/**
 * Wipe everything this module knows. Separate from forget() so a caller can
 * express "the user signed out" versus "the user turned the setting off".
 */
export async function reset(): Promise<void> {
    const held = memoryDek;
    memoryDek = null;
    if (held) {
        // Strings cannot be zeroed in JS; this at least drops the reference and
        // scrubs any buffer form the caller handed us.
        scrub();
    }
    await forget();
}
