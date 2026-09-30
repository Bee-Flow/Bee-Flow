/**
 * One row of a breakdown: who or what, its calls and tokens (when the server
 * shows them), its cost, and a bar of its share of the largest row in the
 * theme's chart colour for its rank.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { compactNumber, currency, shortModel } from '@/features/usage';
import { ProgressBar, Text } from '@/shared/ui';

import { sourceLabel } from '../model/report';
import type { BreakdownReport, BreakdownRow } from '../model/types';

function titleOf(report: BreakdownReport, row: BreakdownRow, t: ReturnType<typeof useTranslation>): string {
    if (report === 'models') return shortModel(row.title);
    if (report === 'sources') return sourceLabel(row.title, t);
    if (report === 'agents' || report === 'models-by-agent') return row.title || t('mobile.orgUsage.direct_chat', 'Direct Chat');
    return row.title;
}

export interface BreakdownItemProps {
    report: BreakdownReport;
    row: BreakdownRow;
    rank: number;
    share: number;
}

export function BreakdownItem({ report, row, rank, share }: BreakdownItemProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const title = titleOf(report, row, t);
    const counts = [
        row.subtitle ? shortModel(row.subtitle) : null,
        row.calls !== null ? t('mobile.orgUsage.calls_count', '{n} calls', { n: compactNumber(row.calls) }) : null,
        row.tokens !== null ? t('mobile.orgUsage.tokens_count', '{n} tokens', { n: compactNumber(row.tokens) }) : null,
    ].filter(Boolean).join(' · ');
    return (
        <View style={styles.row}>
            <View style={styles.line}>
                <Text variant="body" numberOfLines={1} style={styles.title}>{title}</Text>
                <Text variant="body" weight="semibold">{currency(row.cost)}</Text>
            </View>
            {counts ? <Text variant="caption" tone="tertiary" numberOfLines={1}>{counts}</Text> : null}
            <ProgressBar fraction={share} label={title} tint={theme.chart[rank % theme.chart.length]} />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { gap: theme.spacing.xs, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm },
        line: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        title: { flex: 1 },
    });
