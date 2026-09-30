/**
 * The lock screen.
 *
 * The session is still valid; what is missing is the data encryption key. It
 * lives in memory only (src/core/auth/vault.ts) and dies with the process, so a
 * cold start — or two minutes in the background — leaves a signed-in user with
 * a vault they cannot read. When the user opted into keeping the key, it sits
 * in the Android Keystore behind `requireAuthentication`, and a fingerprint or
 * the device credential releases it (useUnlockPrompt).
 */

import React from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { Banner, Button, Text } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { TextLink } from '../components/TextLink';
import { useUnlockPrompt } from '../hooks/useUnlockPrompt';

export function LockedScreen() {
    const { stage, signOut } = useAuth();
    const user = stage.kind === 'locked' ? stage.user : null;
    const { busy, failed, method, attempt } = useUnlockPrompt();
    const t = useTranslation();

    const label = {
        face: t('mobile.onboarding.unlock_face', 'Unlock with face'),
        fingerprint: t('mobile.onboarding.unlock_fingerprint', 'Unlock with fingerprint'),
        device: t('encryption.unlock_button', 'Unlock'),
    }[method];

    return (
        <AuthShell
            icon="Lock"
            title={t('mobile.onboarding.locked_title', 'Bee Flow is locked')}
            subtitle={
                user
                    ? t(
                          'mobile.onboarding.locked_intro_named',
                          '{name}, your data is encrypted on this device. Unlock it to carry on.',
                          { name: user.displayName },
                      )
                    : t('mobile.onboarding.locked_intro', 'Your data is encrypted on this device. Unlock it to carry on.')
            }
            footer={
                <>
                    <TextLink
                        label={t('mobile.onboarding.locked_use_password', 'Use your password instead')}
                        onPress={() => void signOut()}
                        accessibilityHint={t('mobile.onboarding.locked_use_password_hint', 'Signs out and returns to the sign-in screen')}
                    />
                    <Text variant="caption" tone="tertiary" center>
                        {t(
                            'mobile.onboarding.locked_nothing_lost',
                            'Signing in again always works. Nothing is lost — the key is rebuilt from your password.',
                        )}
                    </Text>
                </>
            }
        >
            {failed ? (
                <Banner tone="warning" icon="TriangleAlert">
                    {t(
                        'mobile.onboarding.locked_failed',
                        'That did not unlock it. Try again, or sign in with your password — Android also drops the stored key when you add or change a fingerprint.',
                    )}
                </Banner>
            ) : null}

            <Button label={label} onPress={() => void attempt()} size="lg" fullWidth loading={busy} />
        </AuthShell>
    );
}
