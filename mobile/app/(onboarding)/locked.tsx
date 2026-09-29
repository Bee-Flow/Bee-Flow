/**
 * The lock screen.
 *
 * The session is still valid; what is missing is the data encryption key. It
 * lives in memory only (src/auth/vault.ts) and dies with the process, so a cold
 * start — or two minutes in the background — leaves a signed-in user with a
 * vault they cannot read. When the user opted into keeping the key, it sits in
 * the Android Keystore behind `requireAuthentication`, and a fingerprint or the
 * device credential releases it.
 *
 * `unlock()` returning false is a NORMAL outcome, not an error: the user
 * cancelled the system prompt, or the OS invalidated the key because their
 * biometrics changed. Neither deserves an alert — the first needs the button
 * back, the second needs the password route, and the screen offers both
 * without deciding which happened.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '../../src/auth/AuthProvider';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { Button } from '../../src/ui/Button';
import { Banner } from '../../src/ui/Feedback';
import { Text } from '../../src/ui/Text';

export default function LockedScreen() {
    const { stage, unlock, signOut } = useAuth();
    const user = stage.kind === 'locked' ? stage.user : null;

    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [method, setMethod] = useState<'fingerprint' | 'face' | 'device'>('device');
    const attempted = useRef(false);

    // Name the gesture the phone will actually ask for. "Unlock with
    // fingerprint" on a device that shows a face prompt is a small lie that
    // makes people hesitate at exactly the wrong moment.
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

    // Prompt straight away — the user arrived here on purpose, and making them
    // press a button to be asked for a fingerprint is a step with no content.
    // Once only: re-prompting after a cancel is how an app becomes a fight.
    useEffect(() => {
        if (attempted.current) return;
        attempted.current = true;
        void attempt();
    }, [attempt]);

    const label = {
        face: 'Unlock with face',
        fingerprint: 'Unlock with fingerprint',
        device: 'Unlock',
    }[method];

    return (
        <AuthShell
            icon="lock"
            title="Bee Flow is locked"
            subtitle={
                user
                    ? `${user.displayName}, your data is encrypted on this device. Unlock it to carry on.`
                    : 'Your data is encrypted on this device. Unlock it to carry on.'
            }
            footer={
                <>
                    <TextLink
                        label="Use your password instead"
                        onPress={() => void signOut()}
                        accessibilityHint="Signs out and returns to the sign-in screen"
                    />
                    <Text variant="caption" tone="tertiary" center>
                        Signing in again always works. Nothing is lost — the key is
                        rebuilt from your password.
                    </Text>
                </>
            }
        >
            {failed ? (
                <Banner tone="warning" icon="alert-triangle">
                    That did not unlock it. Try again, or sign in with your password —
                    Android also drops the stored key when you add or change a
                    fingerprint.
                </Banner>
            ) : null}

            <Button label={label} onPress={() => void attempt()} size="lg" fullWidth loading={busy} />
        </AuthShell>
    );
}
