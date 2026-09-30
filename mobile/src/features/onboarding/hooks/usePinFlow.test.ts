/**
 * The encryption-PIN flow's state machine, with the OPAQUE calls mocked: a
 * setup that shows its key once, a refusal to overwrite an existing key that
 * becomes a question, an unlock that turns into setup in place, a wrong PIN,
 * and a recovery — and typed fields surviving a trip between the forms.
 */

import { act, renderHook } from '@testing-library/react-native';

import * as vault from '@/core/auth/vault';

import { usePinFlow } from './usePinFlow';
import {
    EncryptionAlreadySetUpError,
    recoverWithRecoveryKey,
    registerEncryptionPin,
    unlockEncryptionPin,
    WrongPinError,
} from '../api/encryption';

jest.mock('../api/encryption', () => {
    const actual = jest.requireActual('../api/encryption');
    return {
        ...actual,
        registerEncryptionPin: jest.fn(),
        unlockEncryptionPin: jest.fn(),
        recoverWithRecoveryKey: jest.fn(),
    };
});
jest.mock('@/core/auth/vault', () => ({ setDek: jest.fn() }));

const register = registerEncryptionPin as jest.Mock;
const unlock = unlockEncryptionPin as jest.Mock;
const recover = recoverWithRecoveryKey as jest.Mock;

beforeEach(() => jest.clearAllMocks());

async function flow(mode: 'setup' | 'unlock') {
    const onDone = jest.fn();
    const hook = await renderHook(() => usePinFlow(mode, onDone));
    return { ...hook, onDone };
}

describe('usePinFlow', () => {
    it('refuses a short or mismatched PIN before calling the server', async () => {
        const { result } = await flow('setup');
        await act(async () => result.current.set({ pin: '123', confirmPin: '123' }));
        await act(async () => result.current.submit());
        expect(result.current.error).toMatch(/at least 6 characters/);
        expect(register).not.toHaveBeenCalled();
    });

    it('sets a PIN, keeps the key, and shows the recovery key once', async () => {
        register.mockResolvedValueOnce({ recoveryKey: 'AAAA-BBBB', dek: 'ZGVr', mode: 'opaque' });
        const { result, onDone } = await flow('setup');
        await act(async () => result.current.set({ pin: '123456', confirmPin: '123456' }));
        await act(async () => result.current.submit());
        expect(register).toHaveBeenCalledWith('123456', { confirmReplace: false });
        expect(vault.setDek).toHaveBeenCalledWith('ZGVr');
        expect(result.current.step).toBe('saved-key');
        expect(result.current.recoveryKey).toBe('AAAA-BBBB');
        expect(result.current.fields.pin).toBe('');
        expect(onDone).not.toHaveBeenCalled();
    });

    it('asks before replacing an existing key, and only then sends confirmReplace', async () => {
        register.mockRejectedValueOnce(new EncryptionAlreadySetUpError('This account already has a key.'));
        register.mockResolvedValueOnce({ recoveryKey: null, dek: null, mode: 'legacy' });
        const { result, onDone } = await flow('setup');
        await act(async () => result.current.set({ pin: '123456', confirmPin: '123456' }));
        await act(async () => result.current.submit());
        expect(result.current.replaceWarning).toBe('This account already has a key.');
        expect(result.current.error).toBeNull();
        await act(async () => result.current.replaceKey());
        expect(register).toHaveBeenLastCalledWith('123456', { confirmReplace: true });
        expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('turns an unlock into a setup when the account has no PIN yet', async () => {
        unlock.mockResolvedValueOnce({ dek: null, needsSetup: true, mode: 'opaque' });
        const { result, onDone } = await flow('unlock');
        await act(async () => result.current.set({ pin: '123456' }));
        await act(async () => result.current.submit());
        expect(result.current.setupMode).toBe(true);
        expect(result.current.error).toBeNull();
        expect(onDone).not.toHaveBeenCalled();
    });

    it('says a wrong PIN plainly', async () => {
        unlock.mockRejectedValueOnce(new WrongPinError());
        const { result } = await flow('unlock');
        await act(async () => result.current.set({ pin: '000000' }));
        await act(async () => result.current.submit());
        expect(result.current.error).toBe('That PIN is not correct.');
        expect(result.current.busy).toBe(false);
    });

    it('recovers with the saved key, and keeps the typed PIN across the trip', async () => {
        recover.mockResolvedValueOnce({ recoveryKey: 'NEW-KEY' });
        const { result } = await flow('unlock');
        await act(async () => result.current.set({ pin: '999' }));
        await act(async () => result.current.goTo('recover'));
        await act(async () => result.current.set({ recoveryInput: 'OLD-KEY', newPin: '654321', confirmNewPin: '654321' }));
        await act(async () => result.current.goTo('form'));
        expect(result.current.fields.pin).toBe('999');
        await act(async () => result.current.goTo('recover'));
        await act(async () => result.current.recover());
        expect(recover).toHaveBeenCalledWith('OLD-KEY', '654321');
        expect(result.current.step).toBe('saved-key');
        expect(result.current.recoveryKey).toBe('NEW-KEY');
    });
});
