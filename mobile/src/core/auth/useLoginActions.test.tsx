/**
 * The sign-in actions: each login answer enters the right stage, a recovery
 * key is never swallowed, and a failure leaves a sentence for the screen and
 * the busy flag down.
 */

import { act, renderHook } from '@testing-library/react-native';

import { InvalidCredentialsError, opaqueLogin, passwordLogin, verifyMfaLogin } from './api';
import type { User } from './types';
import { useLoginActions } from './useLoginActions';
import * as vault from './vault';

jest.mock('./api', () => ({
    ...jest.requireActual('./api'),
    passwordLogin: jest.fn(),
    opaqueLogin: jest.fn(),
    verifyMfaLogin: jest.fn(),
}));
jest.mock('./vault', () => ({ setDek: jest.fn() }));

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local' };

async function setup() {
    const effects = { setStage: jest.fn(), setPendingRecoveryKey: jest.fn(), onSignedIn: jest.fn() };
    const hook = await renderHook(() => useLoginActions(effects));
    return { ...hook, ...effects };
}

beforeEach(() => jest.clearAllMocks());

describe('useLoginActions', () => {
    it('enters the stage a password login answers, and keeps its recovery key', async () => {
        (passwordLogin as jest.Mock).mockResolvedValue({ success: true, user: ADA, recoveryKey: 'rk' });
        const { result, setStage, setPendingRecoveryKey, onSignedIn } = await setup();
        await act(() => result.current.signIn('ada', 'pw'));
        expect(setPendingRecoveryKey).toHaveBeenCalledWith('rk');
        expect(setStage).toHaveBeenCalledWith({ kind: 'signed-in', user: ADA });
        expect(onSignedIn).toHaveBeenCalled();
        expect(result.current.busy).toBe(false);
    });

    it('does not load permissions for a stage short of signed in', async () => {
        (passwordLogin as jest.Mock).mockResolvedValue({ mfaRequired: true });
        const { result, setStage, onSignedIn } = await setup();
        await act(() => result.current.signIn('ada', 'pw'));
        expect(setStage).toHaveBeenCalledWith({ kind: 'mfa-required', username: 'ada' });
        expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('runs OPAQUE when the account moved to it, and unlocks the vault', async () => {
        (passwordLogin as jest.Mock).mockResolvedValue({ useOpaque: true });
        (opaqueLogin as jest.Mock).mockResolvedValue({ success: true, user: ADA, dek: 'dek' });
        const { result, setStage } = await setup();
        await act(() => result.current.signIn('ada', 'pw'));
        expect(vault.setDek).toHaveBeenCalledWith('dek');
        expect(setStage).toHaveBeenCalledWith({ kind: 'signed-in', user: ADA });
        expect(result.current.keyProgress).toBeNull();
    });

    it('says "Invalid credentials." for wrong credentials and rethrows', async () => {
        (passwordLogin as jest.Mock).mockRejectedValue(new InvalidCredentialsError());
        const { result } = await setup();
        await act(async () => {
            await expect(result.current.signIn('ada', 'nope')).rejects.toBeInstanceOf(InvalidCredentialsError);
        });
        expect(result.current.error).toBe('Invalid credentials.');
        expect(result.current.busy).toBe(false);
        await act(async () => result.current.clearError());
        expect(result.current.error).toBeNull();
    });

    it('signs in on an accepted MFA code and reports a refused one', async () => {
        (verifyMfaLogin as jest.Mock).mockResolvedValueOnce({ success: true, user: ADA });
        const { result, setStage } = await setup();
        await act(() => result.current.submitMfaCode('123456'));
        expect(setStage).toHaveBeenCalledWith({ kind: 'signed-in', user: ADA });

        (verifyMfaLogin as jest.Mock).mockResolvedValueOnce({ success: false });
        await act(async () => {
            await expect(result.current.submitMfaCode('000000')).rejects.toThrow('That code was not accepted.');
        });
        expect(result.current.error).toBe('That code was not accepted.');
    });
});
