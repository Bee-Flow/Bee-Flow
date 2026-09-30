/** How much the review found, and of which kinds (the web's DlpFindingsSummaryBar). */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { DlpSpan } from '@/features/chat/model/dlpSpans';
import { Text } from '@/shared/ui';

import { DlpCategoryBadge } from './DlpCategoryBadge';

const makeStyles = (theme: Theme) => ({
    bar: { gap: theme.spacing.sm },
    badges: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing[1.5] },
});

export function DlpSummaryBar({ spans }: { spans: readonly DlpSpan[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (spans.length === 0) {
        return (
            <Text variant="caption" tone="secondary">
                {t('dlp.summary_none_found', 'No personal data detected. Do you see something anyway? Select it below.')}
            </Text>
        );
    }
    const manual = spans.filter((s) => s.source === 'manual').length;
    const auto = spans.length - manual;
    const categories = [...new Set(spans.map((s) => s.category ?? ''))];
    return (
        <View style={styles.bar}>
            <Text variant="caption" tone="secondary">
                {manual > 0
                    ? t('dlp.summary_with_manual', '{auto} detected · {manual} added by you', { auto, manual })
                    : t('dlp.summary_auto_only', '{count} detected', { count: auto })}
            </Text>
            <View style={styles.badges}>
                {categories.map((category) => (
                    <DlpCategoryBadge key={category} category={category} />
                ))}
            </View>
        </View>
    );
}
