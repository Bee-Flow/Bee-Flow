/**
 * One button per sign-in provider the instance offers, under an OR divider
 * when the password form is there too. While one provider's flow runs, the
 * others wait.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Divider, Icon, Text } from '@/shared/ui';

import { SSO_LABELS, type SsoProvider } from '../api/sso';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stack: { gap: theme.spacing.md },
        divider: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
        rule: { flex: 1 },
    });

export function SsoButtons({
    providers,
    withDivider,
    active,
    busy,
    onStart,
}: {
    providers: SsoProvider[];
    withDivider: boolean;
    /** The provider whose flow is running. */
    active: SsoProvider | null;
    /** A password sign-in is running. */
    busy: boolean;
    onStart: (provider: SsoProvider) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    if (providers.length === 0) return null;
    return (
        <View style={styles.stack}>
            {withDivider ? (
                <View style={styles.divider}>
                    <View style={styles.rule}>
                        <Divider />
                    </View>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.onboarding.or', 'OR')}
                    </Text>
                    <View style={styles.rule}>
                        <Divider />
                    </View>
                </View>
            ) : null}

            {providers.map((provider) => (
                <Button
                    key={provider}
                    label={t('signup.continue_with_provider', 'Continue with {provider}', { provider: SSO_LABELS[provider] })}
                    onPress={() => onStart(provider)}
                    variant="secondary"
                    fullWidth
                    loading={active === provider}
                    disabled={busy || (active !== null && active !== provider)}
                    icon={
                        <Icon
                            name={provider === 'nextcloud' ? 'Cloud' : 'LogIn'}
                            size={16}
                            color={theme.colors.textPrimary}
                        />
                    }
                    accessibilityHint={t('mobile.onboarding.sso_hint', 'Opens your browser to finish signing in')}
                />
            ))}
        </View>
    );
}
