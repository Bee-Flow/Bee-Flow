/** What starts an automation, with the button that changes it. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            minHeight: theme.minTouch,
        },
        text: { flex: 1, gap: 2 },
    });

export function TriggerRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.row}>
            <View style={styles.text}>
                <Text variant="body">{label}</Text>
                <Text variant="caption" tone="tertiary">
                    {value}
                </Text>
            </View>
            <Button label={t('mobile.automations.change', 'Change')} variant="secondary" onPress={onEdit} />
        </View>
    );
}
