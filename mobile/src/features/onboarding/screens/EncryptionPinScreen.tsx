/**
 * Unlock the vault with the encryption PIN.
 *
 * Reached when /auth/user reports `needsEncryptionPin`: the session is real,
 * the account has a key, and the key is still wrapped. Until it is unwrapped
 * most of the product would hand back ciphertext, which is why this stage sits
 * in front of the app rather than behind a banner inside it.
 *
 * The flow can discover the PIN was never set (the server answers `needsSetup`
 * when there is no OPAQUE record) and turns into setup in place — see
 * EncryptionPinFlow for why that cannot be a route change.
 */

import React from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';

import { EncryptionPinFlow } from '../components/EncryptionPinFlow';
import { TextLink } from '../components/TextLink';

export function EncryptionPinScreen() {
    const { refresh, signOut } = useAuth();
    const t = useTranslation();
    return (
        <EncryptionPinFlow
            mode="unlock"
            onDone={() => void refresh()}
            footer={<TextLink label={t('login.sign_out', 'Sign out')} tone="tertiary" onPress={() => void signOut()} />}
        />
    );
}
