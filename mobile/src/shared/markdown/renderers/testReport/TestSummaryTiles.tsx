/**
 * The report's figures: the pass rate in its band's colour, then passed,
 * failed, warnings and skipped — each of those a filter, as on the web: tap
 * to show only those tests, tap again for all.
 */

import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Text } from '@/shared/ui';

import { passRate, rateTone, type TestStatus, type TestSummary } from './testReportModel';
import { statusLabel } from './testWords';
import { TEST_STATUS } from '../rich/richPalette';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing[1.5] },
        tile: {
            flex: 1,
            alignItems: 'center',
            paddingVertical: theme.spacing[3],
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: 'transparent',
            backgroundColor: theme.colors.bgTertiary,
        },
        figure: { fontSize: 20, lineHeight: 24, fontWeight: '800' },
        caption: { fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 },
    }),
);

const COUNTS: { status: TestStatus; key: keyof TestSummary }[] = [
    { status: 'passed', key: 'passed' },
    { status: 'failed', key: 'failed' },
    { status: 'warning', key: 'warnings' },
    { status: 'skipped', key: 'skipped' },
];

function selected(status: TestStatus): ViewStyle {
    return { backgroundColor: TEST_STATUS[status].bg, borderColor: `${TEST_STATUS[status].color}40` };
}

function ink(color: string) {
    return { color };
}

export function TestSummaryTiles({
    summary,
    filter,
    onFilter,
}: {
    summary: TestSummary;
    filter: TestStatus | null;
    onFilter: (status: TestStatus | null) => void;
}) {
    const styles = useThemedStyles(sheet);
    const { t } = useMarkdownEnv();
    const rate = passRate(summary);
    return (
        <View style={styles.row}>
            <View style={styles.tile}>
                <Text style={[styles.figure, ink(TEST_STATUS[rateTone(rate)].color)]}>{`${rate}%`}</Text>
                <Text weight="semibold" tone="tertiary" style={styles.caption} numberOfLines={1}>
                    {t('mobile.markdown.test_pass_rate', 'Pass rate')}
                </Text>
            </View>
            {COUNTS.map(({ status, key }) => (
                <Pressable
                    key={status}
                    onPress={() => onFilter(filter === status ? null : status)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filter === status }}
                    style={[styles.tile, filter === status && selected(status)]}
                >
                    <Text style={[styles.figure, ink(TEST_STATUS[status].color)]}>{summary[key]}</Text>
                    <Text weight="semibold" tone="tertiary" style={styles.caption} numberOfLines={1}>
                        {statusLabel(status, t)}
                    </Text>
                </Pressable>
            ))}
        </View>
    );
}
