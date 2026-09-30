/**
 * A ```json-test-report, natively: the web's TestReportRenderer — a header
 * tinted by the pass rate (green from 80%, amber from 50%, red below) with
 * the tested site, time and duration; the figures, which filter the list;
 * the expandable tests; recommendations; and the notes as Markdown.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Text } from '@/shared/ui';

import { TestCaseRow } from './TestCaseRow';
import { passRate, rateTone, type TestReport, type TestStatus } from './testReportModel';
import { TestSummaryTiles } from './TestSummaryTiles';
import { statusLabel } from './testWords';
import { GradientFill } from '../rich/GradientFill';
import { RichFrame } from '../rich/RichFrame';
import { TEST_STATUS } from '../rich/richPalette';
import { useToggleSet } from '../rich/useToggleSet';

export { readTestReport } from './testReportModel';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        header: { padding: theme.spacing[4], gap: theme.spacing[1.5], borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
        title: { fontSize: 18, lineHeight: 24, ...theme.fonts.bold },
        meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.spacing[4], rowGap: theme.spacing[1] },
        section: { padding: theme.spacing[4], gap: theme.spacing[2] },
        divided: { borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
        empty: { paddingVertical: theme.spacing[6] },
    }),
);

function Header({ data }: { data: TestReport }) {
    const styles = useThemedStyles(sheet);
    const { t } = useMarkdownEnv();
    const band = TEST_STATUS[rateTone(passRate(data.summary))].color;
    const when = data.timestamp ? new Date(data.timestamp) : null;
    return (
        <View style={styles.header}>
            <GradientFill stops={[{ color: band, opacity: 0.08 }, { color: band, opacity: 0 }, { color: band, opacity: 0 }]} angle={135} />
            <Text accessibilityRole="header" style={styles.title}>
                {`🧪 ${data.title || t('mobile.markdown.test_report', 'Test report')}`}
            </Text>
            <View style={styles.meta}>
                {data.url ? <Text variant="label" tone="tertiary">{`🌐 ${data.url}`}</Text> : null}
                {when && !Number.isNaN(when.getTime()) ? (
                    <Text variant="label" tone="tertiary">{`📅 ${when.toLocaleString()}`}</Text>
                ) : null}
                {data.duration ? <Text variant="label" tone="tertiary">{`⏱ ${data.duration}`}</Text> : null}
            </View>
        </View>
    );
}

function Tests({ data, filter }: { data: TestReport; filter: TestStatus | null }) {
    const styles = useThemedStyles(sheet);
    const { t } = useMarkdownEnv();
    const open = useToggleSet();
    const shown = data.tests.map((test, index) => ({ test, index })).filter(({ test }) => !filter || test.status === filter);
    if (!shown.length) {
        const which = filter ? statusLabel(filter, t).toLowerCase() : '';
        return (
            <Text variant="caption" tone="tertiary" center style={styles.empty}>
                {t('mobile.markdown.test_none', 'No {status} tests to display', { status: which }).replace(/\s+/g, ' ')}
            </Text>
        );
    }
    return (
        <>
            {shown.map(({ test, index }) => (
                <TestCaseRow key={index} test={test} open={open.has(index)} onToggle={() => open.toggle(index)} />
            ))}
        </>
    );
}

export function TestReportBlock({ data }: { data: TestReport }) {
    const styles = useThemedStyles(sheet);
    const { t, Nested } = useMarkdownEnv();
    const [filter, setFilter] = useState<TestStatus | null>(null);
    return (
        <RichFrame padded={false}>
            <Header data={data} />
            <View style={styles.section}>
                <TestSummaryTiles summary={data.summary} filter={filter} onFilter={setFilter} />
            </View>
            <View style={[styles.section, styles.divided]}>
                <Tests data={data} filter={filter} />
            </View>
            {data.recommendations.length ? (
                <View style={[styles.section, styles.divided]}>
                    <Text variant="caption" weight="bold">{`💡 ${t('mobile.markdown.test_recommendations', 'Recommendations')}`}</Text>
                    {data.recommendations.map((rec, i) => (
                        <Text key={i} variant="caption" tone="secondary">{`• ${rec}`}</Text>
                    ))}
                </View>
            ) : null}
            {data.notes ? (
                <View style={[styles.section, styles.divided]}>
                    <Nested value={data.notes} />
                </View>
            ) : null}
        </RichFrame>
    );
}
