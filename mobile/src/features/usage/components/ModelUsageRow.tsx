/** One model's share of the period: calls, tokens and — unless flat-rate — cost. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { compactNumber, currency, shortModel } from '../model/format';
import type { ModelUsage } from '../model/types';

export function ModelUsageRow({ row, flatRate }: { row: ModelUsage; flatRate: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <View style={styles.text}>
                <Text variant="body" numberOfLines={1}>
                    {shortModel(row.model)}
                </Text>
                <Text variant="caption" tone="tertiary">
                    {t('mobile.usage.model_line', '{calls} calls · {tokens} tokens', { calls: compactNumber(row.calls), tokens: compactNumber(row.total_tokens) })}
                </Text>
            </View>
            {flatRate ? null : (
                <Text variant="body" tone="tertiary">
                    {currency(row.estimated_cost)}
                </Text>
            )}
        </View>
    );
}

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
