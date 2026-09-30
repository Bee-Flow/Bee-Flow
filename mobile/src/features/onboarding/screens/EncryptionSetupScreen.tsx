/**
 * First-time zero-knowledge setup.
 *
 * Reached when /auth/user reports `needsEncryptionSetup` — an account, usually
 * an SSO one, that has no data encryption key yet. Everything the user goes on
 * to write is encrypted under the key minted here, so this screen is the point
 * of no return for their vault: the whole flow, including the one showing of
 * the recovery key, lives in EncryptionPinFlow.
 */

import React from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';

import { EncryptionPinFlow } from '../components/EncryptionPinFlow';
import { TextLink } from '../components/TextLink';

export function EncryptionSetupScreen() {
    const { refresh, signOut } = useAuth();
    const t = useTranslation();
    return (
        <EncryptionPinFlow
            mode="setup"
            // `refresh` re-reads /auth/user, which now reports the flag cleared,
            // and the gate moves the user into the app.
            onDone={() => void refresh()}
            footer={<TextLink label={t('login.sign_out', 'Sign out')} tone="tertiary" onPress={() => void signOut()} />}
        />
    );
}
