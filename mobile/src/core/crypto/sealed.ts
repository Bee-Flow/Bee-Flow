/**
 * Sealed storage: small values this device must keep for its signed-in
 * person, encrypted at rest.
 *
 * The web keeps nothing of the sort — an unsaved draft there lives in the tab
 * and the server holds the rest. A phone loses its connection far more often
 * than a desk does, and the app can be killed at any moment, so an edit that
 * has not reached the server yet is written here instead of being lost. What
 * goes here is the person's own content (an automation's prompts, say), so it is
 * sealed the way the web seals the data encryption key: AES-256-GCM, a fresh
 * 12-byte IV per write, and additional data that binds each value to its owner
 * and its slot, so a value copied to another slot or another account does not
 * open.
 *
 * The key is 32 random bytes in expo-secure-store — on Android an AES key in
 * the hardware Keystore, readable only while the phone is unlocked and never
 * backed up or moved to another device. The ciphertext sits in AsyncStorage.
 *
 * `wipeSealed()` removes the key and every value; sign-out calls it (as the
 * web's logout clears the person's scoped storage). A value that belongs to
 * someone else, or does not decrypt, is removed on read and reads as nothing.
 */

import { gcm } from '@noble/ciphers/aes.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { fromBase64, scrub, toBase64 } from './keys';
import { randomBytes } from './random';

const KEY_NAME = 'beeflow.sealed.key';
const PREFIX = 'beeflow.sealed.';
const IV_BYTES = 12;
const VERSION = 1;

interface SealedRecord {
    v: number;
    owner: string;
    iv: string;
    ct: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const slotKey = (namespace: string, id: string) => `${PREFIX}${namespace}.${id}`;
const aadFor = (owner: string, namespace: string, id: string) => encoder.encode(`sealed:v${VERSION}:${owner}:${namespace}:${id}`);

let keyPromise: Promise<Uint8Array | null> | null = null;

async function loadKey(create: boolean): Promise<Uint8Array | null> {
    const stored = await SecureStore.getItemAsync(KEY_NAME);
    if (stored) return fromBase64(stored);
    if (!create) return null;
    const fresh = randomBytes(32);
    await SecureStore.setItemAsync(KEY_NAME, toBase64(fresh), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return fresh;
}

/** The device's sealing key, made on first use. Null only when the Keystore refuses. */
function sealingKey(): Promise<Uint8Array | null> {
    keyPromise ??= loadKey(true).catch(() => {
        keyPromise = null;
        return null;
    });
    return keyPromise;
}

/** Seal `value` (JSON) into its slot. False when it could not be stored. */
export async function sealedPut(owner: string, namespace: string, id: string, value: unknown): Promise<boolean> {
    try {
        const key = await sealingKey();
        if (!key) return false;
        const iv = randomBytes(IV_BYTES);
        const ct = gcm(key, iv, aadFor(owner, namespace, id)).encrypt(encoder.encode(JSON.stringify(value)));
        const record: SealedRecord = { v: VERSION, owner, iv: toBase64(iv), ct: toBase64(ct) };
        await AsyncStorage.setItem(slotKey(namespace, id), JSON.stringify(record));
        return true;
    } catch {
        return false;
    }
}

/** The value in a slot, for this owner; null when there is none or it does not open. */
export async function sealedGet<T>(owner: string, namespace: string, id: string): Promise<T | null> {
    const slot = slotKey(namespace, id);
    let raw: string | null;
    try {
        raw = await AsyncStorage.getItem(slot);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const record = JSON.parse(raw) as SealedRecord;
        if (record.v !== VERSION || record.owner !== owner) throw new Error('not this owner');
        const key = await sealingKey();
        if (!key) return null;
        const plain = gcm(key, fromBase64(record.iv), aadFor(owner, namespace, id)).decrypt(fromBase64(record.ct));
        const value = JSON.parse(decoder.decode(plain)) as T;
        scrub(plain);
        return value;
    } catch {
        await sealedRemove(namespace, id);
        return null;
    }
}

export async function sealedRemove(namespace: string, id: string): Promise<void> {
    try {
        await AsyncStorage.removeItem(slotKey(namespace, id));
    } catch {
        // Nothing to do: an unreadable slot is removed again on its next read.
    }
}

/** Forget everything sealed on this device, and the key. Sign-out calls this. */
export async function wipeSealed(): Promise<void> {
    keyPromise = null;
    try {
        const keys = await AsyncStorage.getAllKeys();
        const ours = keys.filter((k) => k.startsWith(PREFIX));
        if (ours.length) await AsyncStorage.multiRemove(ours);
    } catch {
        // The key goes below regardless, and without it nothing left opens.
    }
    try {
        await SecureStore.deleteItemAsync(KEY_NAME);
    } catch {
        // As above: best effort, and the values are unreadable without the key.
    }
}

/** FOR TESTS: forget the cached key so the next call reads SecureStore again. */
export function resetSealedCacheForTests(): void {
    keyPromise = null;
}
