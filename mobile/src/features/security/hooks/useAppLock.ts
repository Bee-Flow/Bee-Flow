/**
 * App lock: the DEK held in the Android keystore behind a biometric prompt
 * (core/auth/vault.ts), on or off for this account on this phone.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import * as vault from '@/core/auth/vault';
import { useToast } from '@/shared/ui';

import { describeBiometrics } from '../model/device';

export interface AppLock {
    /** null until the keystore answered. */
    available: boolean | null;
    enabled: boolean;
    /** "your fingerprint" and the like, for the footer sentence. */
    biometricKind: string;
    error: string | null;
    toggle: (next: boolean) => Promise<void>;
}

export function useAppLock(): AppLock {
    const { user } = useAuth();
    const { toast } = useToast();
    const [available, setAvailable] = useState<boolean | null>(null);
    const [enabled, setEnabled] = useState(false);
    const [biometricKind, setBiometricKind] = useState('biometrics');
    const [error, setError] = useState<string | null>(null);

    /**
     * Read the device's capability and this account's current opt-in state.
     *
     * Three independent platform reads, so they run together — and the `alive`
     * guard matters because `canUseBiometricAuthentication` can take a moment
     * on a cold keystore, which is long enough for the screen to be popped.
     */
    useEffect(() => {
        let alive = true;
        void (async () => {
            const [canPersist, owner, types] = await Promise.all([
                vault.canPersist(),
                vault.persistedOwner(),
                LocalAuthentication.supportedAuthenticationTypesAsync().catch(
                    (): LocalAuthentication.AuthenticationType[] => [],
                ),
            ]);
            if (!alive) return;
            setAvailable(canPersist);
            setEnabled(Boolean(owner && user && owner === user.id));
            setBiometricKind(describeBiometrics(types));
        })();
        return () => {
            alive = false;
        };
    }, [user]);

    /**
     * Turning it ON needs the DEK in memory, which is only true for a session
     * that actually unlocked (an OPAQUE sign-in, or a biometric unlock this
     * launch). A password-era session may be perfectly valid and still have no
     * DEK here, and the correct answer then is "sign out and back in", not a
     * silent failure that leaves the toggle looking on.
     */
    const toggle = async (next: boolean) => {
        setError(null);
        if (!next) {
            await vault.forget();
            setEnabled(false);
            toast('App lock turned off', 'neutral');
            return;
        }
        const dek = vault.getDek();
        if (!user || !dek) {
            setError(
                'Bee Flow does not have your encryption key in memory right now. Sign out and sign back in, then turn this on.',
            );
            return;
        }
        try {
            await vault.persist(user.id, dek);
            setEnabled(true);
            toast('App lock is on', 'success');
        } catch (err) {
            setError(describeError(err).message);
        }
    };

    return { available, enabled, biometricKind, error, toggle };
}
