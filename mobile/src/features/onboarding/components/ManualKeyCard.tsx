/**
 * The TOTP secret for typing by hand, in base32 groups of four: the difference
 * between a key someone can type and one they give up on.
 */

import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Text, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ stack: { gap: theme.spacing.sm }, key: { letterSpacing: 1 } });

export function ManualKeyCard({ secret }: { secret: string }) {
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const t = useTranslation();
    const grouped = secret.replace(/(.{4})/g, '$1 ').trim();
    return (
        <Card padded>
            <View style={styles.stack}>
                <Text variant="caption" tone="secondary">
                    {t('mfa.cant_scan', 'Can’t scan? Enter this key by hand instead.')}
                </Text>
                <Text variant="code" selectable style={styles.key}>
                    {grouped}
                </Text>
                <Button
                    label={t('mobile.onboarding.copy_key', 'Copy key')}
                    variant="secondary"
                    onPress={() => {
                        void Clipboard.setStringAsync(secret);
                        toast(t('mobile.onboarding.key_copied', 'Setup key copied'), 'success');
                    }}
                />
            </View>
        </Card>
    );
}
