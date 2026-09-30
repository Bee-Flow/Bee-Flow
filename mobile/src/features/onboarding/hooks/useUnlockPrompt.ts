/**
 * The lock screen's biometric prompt.
 *
 * It names the gesture the phone will actually ask for — "Unlock with
 * fingerprint" on a device that shows a face prompt is a small lie that makes
 * people hesitate at exactly the wrong moment — and prompts straight away,
 * once: the user arrived on purpose, but re-prompting after a cancel is how an
 * app becomes a fight.
 *
 * `unlock()` returning false is a NORMAL outcome, not an error: the user
 * cancelled the system prompt, or the OS invalidated the key because their
 * biometrics changed. Neither deserves an alert; `failed` just brings the
 * button back next to the password route.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';

export type UnlockMethod = 'fingerprint' | 'face' | 'device';

export function useUnlockPrompt() {
    const { unlock } = useAuth();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [method, setMethod] = useState<UnlockMethod>('device');
    const attempted = useRef(false);

    useEffect(() => {
        let alive = true;
        void (async () => {
            const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
            if (!alive) return;
            if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
                setMethod('face');
            } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
                setMethod('fingerprint');
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    const attempt = useCallback(async () => {
        setBusy(true);
        setFailed(false);
        try {
            const ok = await unlock();
            if (!ok) setFailed(true);
        } finally {
            setBusy(false);
        }
    }, [unlock]);

    useEffect(() => {
        if (attempted.current) return;
        attempted.current = true;
        void attempt();
    }, [attempt]);

    return { busy, failed, method, attempt };
}
