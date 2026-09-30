/**
 * The PIN form's fields: one PIN to unlock, or a PIN and its confirmation to
 * set one — and what to do if it is forgotten. Setting one, the keyboard's
 * Next moves on to the confirmation without closing the keyboard.
 */

import React, { useRef } from 'react';
import type { TextInput } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Banner, Button, Text, TextField } from '@/shared/ui';

import { TextLink } from './TextLink';
import type { PinFields } from '../hooks/usePinFlow';
import { MIN_PIN_LENGTH } from '../model/pin';

export function PinEntryFields({
    setupMode,
    fields,
    set,
    error,
    busy,
    onSubmit,
    onForgot,
}: {
    setupMode: boolean;
    fields: PinFields;
    set: (patch: Partial<PinFields>) => void;
    error: string | null;
    busy: boolean;
    onSubmit: () => void;
    onForgot: () => void;
}) {
    const confirmField = useRef<TextInput>(null);
    const t = useTranslation();
    return (
        <>
            {error ? <Banner tone="error">{error}</Banner> : null}

            <TextField
                label={
                    setupMode
                        ? t('encryption.choose_pin_label', 'Choose an encryption PIN')
                        : t('encryption.pin_label', 'Encryption PIN')
                }
                value={fields.pin}
                onChangeText={(pin) => set({ pin })}
                secure
                autoFocus
                textContentType={setupMode ? 'newPassword' : 'password'}
                returnKeyType={setupMode ? 'next' : 'go'}
                submitBehavior={setupMode ? 'submit' : 'blurAndSubmit'}
                onSubmitEditing={setupMode ? () => confirmField.current?.focus() : onSubmit}
                hint={setupMode ? t('mobile.onboarding.pin_min_length', 'At least {n} characters.', { n: MIN_PIN_LENGTH }) : undefined}
            />

            {setupMode ? (
                <TextField
                    ref={confirmField}
                    label={t('encryption.confirm_pin_label', 'Confirm PIN')}
                    value={fields.confirmPin}
                    onChangeText={(confirmPin) => set({ confirmPin })}
                    secure
                    returnKeyType="go"
                    onSubmitEditing={onSubmit}
                />
            ) : null}

            <Button
                label={setupMode ? t('encryption.setup_button', 'Turn on encryption') : t('encryption.unlock_button', 'Unlock')}
                onPress={onSubmit}
                size="lg"
                fullWidth
                loading={busy}
            />

            {setupMode ? (
                <Text variant="caption" tone="tertiary" center>
                    {t(
                        'mobile.onboarding.pin_no_reset',
                        'Bee Flow cannot reset this PIN for you. You will get a recovery key on the next screen — that is the only other way in.',
                    )}
                </Text>
            ) : (
                <TextLink label={t('encryption.forgot_pin', 'Forgot your PIN? Use your recovery key')} onPress={onForgot} />
            )}
        </>
    );
}
