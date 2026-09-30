/**
 * unlockWithBiometrics used to wipe the persisted key on ANY thrown error,
 * so a cancelled prompt or a transient keystore failure cost the user their
 * biometric unlock. The native module already answers null for an
 * invalidated key; only that path may forget.
 */

import * as SecureStore from 'expo-secure-store';

import { getDek, setDek, unlockWithBiometrics } from './vault';

jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(),
    setItemAsync: jest.fn(),
    deleteItemAsync: jest.fn(async () => undefined),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));
jest.mock('@/core/crypto/keys', () => ({ scrub: jest.fn() }));

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;

beforeEach(() => {
    setDek(null);
    getItemAsync.mockReset();
    deleteItemAsync.mockClear();
});

describe('unlockWithBiometrics', () => {
    it('loads the key the keystore releases', async () => {
        getItemAsync.mockResolvedValueOnce('ZGVr');
        await expect(unlockWithBiometrics()).resolves.toBe(true);
        expect(getDek()).toBe('ZGVr');
        expect(deleteItemAsync).not.toHaveBeenCalled();
    });

    it('forgets a key the OS has invalidated (null from the keystore)', async () => {
        getItemAsync.mockResolvedValueOnce(null);
        await expect(unlockWithBiometrics()).resolves.toBe(false);
        expect(getDek()).toBeNull();
        expect(deleteItemAsync).toHaveBeenCalledWith('beeflow.vault.dek', expect.anything());
    });

    it('keeps the key when the prompt is cancelled or the keystore hiccups', async () => {
        getItemAsync.mockRejectedValueOnce(new Error('User canceled the authentication'));
        await expect(unlockWithBiometrics()).resolves.toBe(false);
        expect(getDek()).toBeNull();
        expect(deleteItemAsync).not.toHaveBeenCalled();
    });
});
