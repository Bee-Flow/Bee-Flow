/**
 * A ```vega-lite chart, drawn natively on the theme's chart colours (the web
 * paints vega-embed's SVG in a fixed indigo palette; the phone uses the
 * `--chart-*` tokens every other chart in the app uses). The card is the
 * web's: the tertiary surface, a subtle border, a 12px radius, the title and
 * subtitle above the plot and the legend below it.
 *
 * A spec outside the native subset (vegaSpec.ts) keeps its card and shows
 * its data as a table, with a line saying so — the numbers are what the
 * reader came for, and a wrong chart would be worse than none.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Text } from '@/shared/ui';

import { ArcChart } from './ArcChart';
import { CartesianChart } from './CartesianChart';
import { ChartLegend } from './ChartLegend';
import { buildChart } from './chartModel';
import type { Row, VegaChart } from './vegaSpec';
import { TextTable } from '../table/TextTable';

export { readChartSource } from './vegaSpec';

const MAX_ROWS = 50;
const MAX_COLUMNS = 8;

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        card: {
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgTertiary,
            paddingVertical: theme.spacing[3],
            gap: theme.spacing[2],
            overflow: 'hidden',
        },
        titles: { paddingHorizontal: theme.spacing[3], gap: 2 },
        plot: { minHeight: 1 },
        table: { paddingHorizontal: theme.spacing[3], gap: theme.spacing[2] },
    }),
);

function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The spec's own data as rows of text: the first columns seen, the first rows. */
export function dataTable(values: readonly Row[]): { header: string[]; rows: string[][] } {
    const header = [...new Set(values.flatMap((row) => Object.keys(row)))].slice(0, MAX_COLUMNS);
    const rows = values.slice(0, MAX_ROWS).map((row) => header.map((key) => cellText(row[key])));
    return { header, rows };
}

export function ChartBlock({ spec }: { spec: VegaChart }) {
    const styles = useThemedStyles(sheet);
    const { theme, t } = useMarkdownEnv();
    const [width, setWidth] = useState(0);
    const model = buildChart(spec, theme.chart);
    const label = spec.title || t('mobile.markdown.chart', 'Chart');
    const table = model.kind === 'table' ? dataTable(spec.values) : null;

    return (
        <View style={styles.card}>
            {spec.title || spec.subtitle ? (
                <View style={styles.titles}>
                    {spec.title ? <Text variant="caption" weight="semibold">{spec.title}</Text> : null}
                    {spec.subtitle ? <Text variant="label" tone="secondary">{spec.subtitle}</Text> : null}
                </View>
            ) : null}
            {table ? (
                <View style={styles.table}>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.markdown.chart_as_table', 'This chart is shown as its data on the phone.')}
                    </Text>
                    {table.header.length ? <TextTable header={table.header} rows={table.rows} /> : null}
                </View>
            ) : (
                <View style={styles.plot} onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}>
                    {width > 0 && model.kind === 'cartesian' ? <CartesianChart model={model} width={width} theme={theme} label={label} /> : null}
                    {width > 0 && model.kind === 'arc' ? <ArcChart model={model} width={width} theme={theme} label={label} /> : null}
                </View>
            )}
            {model.kind !== 'table' ? <ChartLegend items={model.legend} /> : null}
        </View>
    );
}
