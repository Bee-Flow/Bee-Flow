/**
 * "Use your recovery key": the saved key unwraps the data and a new PIN
 * replaces the old one, which stops working.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Button, TextField } from '@/shared/ui';

import { AuthShell } from './AuthShell';
import { TextLink } from './TextLink';
import type { PinFields } from '../hooks/usePinFlow';
import { MIN_PIN_LENGTH } from '../model/pin';

export function PinRecoveryForm({
    fields,
    set,
    error,
    busy,
    onRecover,
    onBack,
}: {
    fields: PinFields;
    set: (patch: Partial<PinFields>) => void;
    error: string | null;
    busy: boolean;
    onRecover: () => void;
    onBack: () => void;
}) {
    const t = useTranslation();
    const minLength = t('mobile.onboarding.pin_min_length', 'At least {n} characters.', { n: MIN_PIN_LENGTH });
    return (
        <AuthShell
            icon="LifeBuoy"
            tone="warning"
            title={t('mobile.onboarding.recover_title', 'Use your recovery key')}
            subtitle={t(
                'mobile.onboarding.recover_intro',
                'Your recovery key unwraps your data and lets you set a new PIN. The old PIN stops working.',
            )}
            footer={<TextLink label={t('encryption.back_to_pin', 'Back to PIN entry')} tone="tertiary" onPress={onBack} />}
        >
            {error ? <Banner tone="error">{error}</Banner> : null}

            <TextField
                label={t('encryption.recovery_key_label', 'Recovery key')}
                value={fields.recoveryInput}
                onChangeText={(recoveryInput) => set({ recoveryInput })}
                placeholder="A1B2C3D4-E5F6…"
                multiline
                maxLines={3}
                autoCapitalize="characters"
                autoCorrect={false}
                hint={t('mobile.onboarding.recovery_key_hint', 'Case and dashes do not matter.')}
            />
            <TextField
                label={t('encryption.new_pin_label', 'New PIN')}
                value={fields.newPin}
                onChangeText={(newPin) => set({ newPin })}
                secure
                textContentType="newPassword"
                hint={minLength}
            />
            <TextField
                label={t('encryption.confirm_new_pin_label', 'Confirm new PIN')}
                value={fields.confirmNewPin}
                onChangeText={(confirmNewPin) => set({ confirmNewPin })}
                secure
                returnKeyType="go"
                onSubmitEditing={onRecover}
            />
            <Button
                label={t('encryption.recover_set_new_pin', 'Recover and set new PIN')}
                onPress={onRecover}
                size="lg"
                fullWidth
                loading={busy}
            />
        </AuthShell>
    );
}
