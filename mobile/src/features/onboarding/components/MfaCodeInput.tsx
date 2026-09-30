/**
 * The second-factor field: six digit boxes for an authenticator code, or a
 * text field for a one-time recovery code.
 *
 * A TOTP code submits the moment six digits are in. It is only valid for
 * thirty seconds — making someone type six digits and then reach for a button
 * spends a meaningful slice of that window.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, TextField } from '@/shared/ui';

import { CodeField } from './CodeField';

export const MFA_CODE_LENGTH = 6;

const makeStyles = (theme: Theme) => StyleSheet.create({ stack: { gap: theme.spacing.sm } });

export function MfaCodeInput({
    mode,
    code,
    onCode,
    busy,
    hasError,
    clearError,
    onSubmit,
}: {
    mode: 'totp' | 'recovery';
    code: string;
    onCode: (value: string) => void;
    busy: boolean;
    hasError: boolean;
    clearError: () => void;
    onSubmit: (value: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();

    if (mode === 'recovery') {
        return (
            <TextField
                label={t('mfa.recovery_code', 'Recovery code')}
                value={code}
                onChangeText={(value) => {
                    onCode(value);
                    if (hasError) clearError();
                }}
                placeholder="a1b2-c3d4"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!busy}
                returnKeyType="go"
                onSubmitEditing={() => onSubmit(code)}
                hint={t('mobile.onboarding.recovery_code_hint', 'Using a recovery code uses it up. You have ten in total.')}
            />
        );
    }

    const onChangeTotp = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, MFA_CODE_LENGTH);
        onCode(digits);
        if (hasError) clearError();
        if (digits.length === MFA_CODE_LENGTH && !busy) onSubmit(digits);
    };

    return (
        <View style={styles.stack}>
            <CodeField
                value={code}
                onChangeText={onChangeTotp}
                length={MFA_CODE_LENGTH}
                autoFocus
                editable={!busy}
                accessibilityLabel={t('mobile.onboarding.mfa_code_label', 'Six-digit authentication code')}
            />
            <Text variant="caption" tone="tertiary" center>
                {t(
                    'mobile.onboarding.mfa_clock_note',
                    'Codes change every 30 seconds. If yours keeps being refused, check that this phone’s clock is set automatically.',
                )}
            </Text>
        </View>
    );
}
