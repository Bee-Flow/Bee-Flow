/**
 * The enrolment itself: scan (or type) the secret, then enter the six digits
 * the authenticator shows. A clock more than 45 seconds off the server's is
 * said out loud — TOTP tolerates ±30s, and past that every code is refused
 * for a reason nobody guesses.
 */

import type { UseMutationResult } from '@tanstack/react-query';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import { AuthShell } from './AuthShell';
import { CodeField } from './CodeField';
import { ManualKeyCard } from './ManualKeyCard';
import { MfaSetupQr } from './MfaSetupQr';
import { TextLink } from './TextLink';
import type { MfaEnableResponse, MfaSetupData } from '../hooks/mfa';

const CODE_LENGTH = 6;
/** TOTP tolerates ±30s. Past that, codes fail for a reason nobody guesses. */
const DRIFT_WARNING_MS = 45_000;

const makeStyles = (theme: Theme) => StyleSheet.create({ stack: { gap: theme.spacing.sm } });

export interface MfaEnrolmentProps {
    data: MfaSetupData;
    code: string;
    onCode: (value: string) => void;
    enable: UseMutationResult<MfaEnableResponse, Error, string>;
    restarting: boolean;
    onStartOver: () => void;
    onSignOut: () => void;
}

export function MfaEnrolment({ data, code, onCode, enable, restarting, onStartOver, onSignOut }: MfaEnrolmentProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const driftSeconds = Math.round(Math.abs(data.driftMs) / 1000);

    return (
        <AuthShell
            icon="Shield"
            title={t('mfa.required_title', 'Set up two-factor sign-in')}
            subtitle={t(
                'mobile.onboarding.mfa_setup_intro',
                'This server requires a second factor. Scan the code with an authenticator app — Google Authenticator, Aegis, 1Password, whichever you already use.',
            )}
            footer={
                <>
                    <TextLink
                        label={t('mobile.onboarding.mfa_start_over', 'Start over with a new code')}
                        tone="tertiary"
                        onPress={onStartOver}
                        disabled={restarting}
                        accessibilityHint={t('mobile.onboarding.mfa_start_over_hint', 'Discards this secret and generates another')}
                    />
                    <TextLink label={t('login.sign_out', 'Sign out')} tone="tertiary" onPress={onSignOut} />
                </>
            }
        >
            {Math.abs(data.driftMs) > DRIFT_WARNING_MS ? (
                <Banner tone="warning" icon="Clock">
                    {t(
                        'mfa.time_drift_warning',
                        'This phone’s clock is about {n} seconds off the server’s. Turn on automatic date and time, or every code you enter will be refused.',
                        { n: driftSeconds },
                    )}
                </Banner>
            ) : null}

            <MfaSetupQr otpauthUrl={data.otpauthUrl} png={data.qr} />
            <ManualKeyCard secret={data.secret} />

            {enable.isError ? <Banner tone="error">{describeError(enable.error).message}</Banner> : null}

            <View style={styles.stack}>
                <Text variant="caption" tone="secondary">
                    {t('mfa.setup_step3', 'Then enter the six digits your app shows.')}
                </Text>
                <CodeField
                    value={code}
                    onChangeText={onCode}
                    length={CODE_LENGTH}
                    editable={!enable.isPending}
                    onComplete={(value) => enable.mutate(value)}
                    accessibilityLabel={t('mobile.onboarding.mfa_setup_code_label', 'Six-digit code from your authenticator app')}
                />
            </View>

            <Button
                label={t('mobile.onboarding.mfa_turn_on', 'Turn on two-factor')}
                onPress={() => enable.mutate(code)}
                size="lg"
                fullWidth
                loading={enable.isPending}
                disabled={code.length !== CODE_LENGTH}
            />
        </AuthShell>
    );
}
