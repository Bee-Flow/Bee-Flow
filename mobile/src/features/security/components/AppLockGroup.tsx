/**
 * App lock, on this phone. On, the key sits in the hardware keystore behind a
 * biometric prompt and the app locks itself after two minutes away. Off (the
 * default), nothing is kept on the phone and nothing is asked: the signed-in
 * session carries the user (core/auth/vault.ts says so in as many words). The
 * words here used to promise a password at every cold start and a relock
 * with the lock off — protection that was not there, told to exactly the
 * person deciding whether to turn the lock on.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, InfoRow, NoteRow, Text, ToggleRow } from '@/shared/ui';

import type { AppLock } from '../hooks/useAppLock';

function footerFor(lock: AppLock, t: ReturnType<typeof useTranslation>): string {
    if (lock.available === false) {
        return t(
            'mobile.security.lock_unavailable',
            'Your phone has no screen lock or enrolled fingerprint, so there is nowhere safe to keep the key. Set one up in Android settings and this becomes available.',
        );
    }
    return t(
        'mobile.security.lock_explained',
        'With app lock off, anyone who can open this phone can open Bee Flow while you are signed in. With it on, the key is held in this phone’s hardware keystore and released only after {method}, and Bee Flow locks itself after two minutes in the background. Android invalidates the key if you enrol a new fingerprint.',
        { method: lock.biometricKind },
    );
}

export function AppLockGroup({ lock }: { lock: AppLock }) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <Group title="On this phone" footer={footerFor(lock, t)}>
            <ToggleRow
                label="Unlock with biometrics"
                description={
                    lock.enabled
                        ? 'Your key is stored on this device, behind the keystore'
                        : 'Your key is never written to storage'
                }
                value={lock.enabled}
                disabled={lock.available !== true}
                onValueChange={(next) => void lock.toggle(next)}
                icon={
                    <Icon
                        name={lock.enabled ? 'LockOpen' : 'Lock'}
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                }
            />
            {lock.error ? (
                <NoteRow>
                    <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                        {lock.error}
                    </Text>
                </NoteRow>
            ) : null}
            {lock.enabled ? <InfoRow label="Relocks after" value="2 minutes in the background" /> : null}
        </Group>
    );
}
