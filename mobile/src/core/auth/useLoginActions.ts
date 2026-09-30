/**
 * Password, OPAQUE and MFA sign-in, with the busy flag, the OPAQUE progress
 * and the error message the sign-in screens render. Split out of AuthProvider;
 * which stage a login answer leads to is decided in session.ts.
 */

import { useCallback, useState } from 'react';

import { InvalidCredentialsError, opaqueLogin, passwordLogin, verifyMfaLogin } from './api';
import { stageForLoginResult } from './session';
import type { AuthStage, LoginResponse } from './types';
import * as vault from './vault';

interface LoginEffects {
    setStage: (stage: AuthStage) => void;
    /** Hold a recovery key the server minted during this sign-in. */
    setPendingRecoveryKey: (key: string) => void;
    /** Called on entering the signed-in stage. */
    onSignedIn: () => void;
}

export interface LoginActions {
    signIn: (username: string, password: string) => Promise<void>;
    submitMfaCode: (code: string) => Promise<void>;
    busy: boolean;
    setBusy: (busy: boolean) => void;
    keyProgress: number | null;
    error: string | null;
    clearError: () => void;
}

export function useLoginActions({ setStage, setPendingRecoveryKey, onSignedIn }: LoginEffects): LoginActions {
    const [busy, setBusy] = useState(false);
    const [keyProgress, setKeyProgress] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const enter = useCallback(
        (next: AuthStage) => {
            setStage(next);
            if (next.kind === 'signed-in') onSignedIn();
        },
        [setStage, onSignedIn],
    );

    const applyLoginResult = useCallback(
        (result: LoginResponse, username: string) => {
            if (result.recoveryKey) setPendingRecoveryKey(result.recoveryKey);
            enter(stageForLoginResult(result, username, 'Sign-in failed.'));
        },
        [enter, setPendingRecoveryKey],
    );

    const signIn = useCallback(
        async (username: string, password: string) => {
            setBusy(true);
            setError(null);
            try {
                const first = await passwordLogin(username, password);
                if (first.useOpaque) {
                    // The account moved to OPAQUE. The password above was never
                    // checked — run the real protocol now.
                    const result = await opaqueLogin(username, password, setKeyProgress);
                    if (result.dek) vault.setDek(result.dek);
                    enter({ kind: 'signed-in', user: result.user });
                    return;
                }
                applyLoginResult(first, username);
            } catch (err) {
                setError(
                    err instanceof InvalidCredentialsError
                        ? 'Invalid credentials.'
                        : (err as Error)?.message || 'Sign-in failed.',
                );
                throw err;
            } finally {
                setBusy(false);
                setKeyProgress(null);
            }
        },
        [applyLoginResult, enter],
    );

    const submitMfaCode = useCallback(
        async (code: string) => {
            setBusy(true);
            setError(null);
            try {
                const result = await verifyMfaLogin(code);
                if (result.recoveryKey) setPendingRecoveryKey(result.recoveryKey);
                if (result.success && result.user) {
                    enter({ kind: 'signed-in', user: result.user });
                    return;
                }
                throw new Error(result.error || 'That code was not accepted.');
            } catch (err) {
                setError((err as Error)?.message || 'That code was not accepted.');
                throw err;
            } finally {
                setBusy(false);
            }
        },
        [enter, setPendingRecoveryKey],
    );

    const clearError = useCallback(() => setError(null), []);

    return { signIn, submitMfaCode, busy, setBusy, keyProgress, error, clearError };
}
