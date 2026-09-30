/**
 * "Create an account", for an instance that accepts them. Sign-up is a long
 * form with plan selection and, on some instances, a captcha — all of it
 * web-only. Handing it to the browser is honest; a half-port that cannot
 * complete would not be.
 */

import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { TextLink } from './TextLink';

const makeStyles = (theme: Theme) => StyleSheet.create({ stack: { gap: theme.spacing.xs, alignItems: 'center' } });

export function SignupHint({ serverUrl, waitlist }: { serverUrl: string; waitlist: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.stack}>
            <Text variant="caption" tone="tertiary" center>
                {waitlist
                    ? t('mobile.onboarding.signup_waitlist', 'New accounts on this server join a waiting list.')
                    : t('mobile.onboarding.signup_open', 'This server accepts new accounts.')}
            </Text>
            <TextLink
                label={t('login.create_account', 'Create an account')}
                onPress={() => void WebBrowser.openBrowserAsync(`${serverUrl}/login?signup=1`, { createTask: false })}
                accessibilityHint={t('mobile.onboarding.signup_hint', 'Opens the sign-up form in your browser')}
            />
        </View>
    );
}
