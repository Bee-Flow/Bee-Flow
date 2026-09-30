import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { resetSealedCacheForTests, sealedGet, sealedPut, sealedRemove, wipeSealed } from './sealed';

beforeEach(async () => {
    await wipeSealed();
    resetSealedCacheForTests();
});

describe('sealed storage', () => {
    it('round-trips a value for its owner', async () => {
        expect(await sealedPut('u1', 'flow', 'a1', { steps: [1, 2] })).toBe(true);
        expect(await sealedGet('u1', 'flow', 'a1')).toEqual({ steps: [1, 2] });
    });

    it('stores ciphertext, never the plain content', async () => {
        await sealedPut('u1', 'flow', 'a1', { prompt: 'Email Jan about the contract' });
        const raw = await AsyncStorage.getItem('beeflow.sealed.flow.a1');
        expect(raw).not.toBeNull();
        expect(raw).not.toContain('Jan');
        expect(raw).not.toContain('contract');
    });

    it('does not open for another owner, and removes it', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        expect(await sealedGet('u2', 'flow', 'a1')).toBeNull();
        expect(await AsyncStorage.getItem('beeflow.sealed.flow.a1')).toBeNull();
    });

    it('does not open when copied to another slot', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        const raw = await AsyncStorage.getItem('beeflow.sealed.flow.a1');
        await AsyncStorage.setItem('beeflow.sealed.flow.a2', raw ?? '');
        expect(await sealedGet('u1', 'flow', 'a2')).toBeNull();
    });

    it('uses a fresh IV per write', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        const first = JSON.parse((await AsyncStorage.getItem('beeflow.sealed.flow.a1')) ?? '{}');
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        const second = JSON.parse((await AsyncStorage.getItem('beeflow.sealed.flow.a1')) ?? '{}');
        expect(first.iv).not.toBe(second.iv);
    });

    it('keeps the key in SecureStore, device-only', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        expect(SecureStore.setItemAsync).toHaveBeenCalledWith('beeflow.sealed.key', expect.any(String), {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
    });

    it('wipes every value and the key', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        await AsyncStorage.setItem('beeflow.other', 'kept');
        await wipeSealed();
        expect(await AsyncStorage.getItem('beeflow.sealed.flow.a1')).toBeNull();
        expect(await SecureStore.getItemAsync('beeflow.sealed.key')).toBeNull();
        expect(await AsyncStorage.getItem('beeflow.other')).toBe('kept');
    });

    it('a value sealed under a wiped key reads as nothing', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        const raw = await AsyncStorage.getItem('beeflow.sealed.flow.a1');
        await wipeSealed();
        await AsyncStorage.setItem('beeflow.sealed.flow.a1', raw ?? '');
        await sealedPut('u1', 'flow', 'other', { y: 2 }); // a new key is made
        expect(await sealedGet('u1', 'flow', 'a1')).toBeNull();
    });

    it('removes one slot', async () => {
        await sealedPut('u1', 'flow', 'a1', { x: 1 });
        await sealedRemove('flow', 'a1');
        expect(await sealedGet('u1', 'flow', 'a1')).toBeNull();
    });
});
