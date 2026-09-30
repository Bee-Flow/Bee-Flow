/**
 * A table of plain text: a page's `table` element (the web PageRenderer's
 * rounded table with a tinted header row and a rule between rows), and a
 * chart's data when the chart itself cannot be drawn. Columns are sized from
 * their text (tableLayout.ts) and the table scrolls sideways when wide.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { columnWidths } from './tableLayout';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        table: { borderRadius: 12, borderWidth: 1, borderColor: theme.colors.borderDefault, overflow: 'hidden' },
        row: { flexDirection: 'row' },
        head: { backgroundColor: theme.colors.bgTertiary },
        cell: { paddingVertical: 10, paddingHorizontal: 14, fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
        headCell: { fontWeight: '600', color: theme.colors.textPrimary },
        ruled: { borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
    }),
);

function width(value: number | undefined): ViewStyle {
    return { width: value };
}

export function TextTable({ header, rows }: { header: string[]; rows: string[][] }) {
    const styles = useThemedStyles(sheet);
    // A few points wider than the Markdown table's: these cells use 14px text.
    const widths = columnWidths(header, rows).map((w) => w + 8);
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.table}>
                <View style={[styles.row, styles.head]}>
                    {header.map((title, i) => (
                        <Text key={i} style={[styles.cell, styles.headCell, width(widths[i])]}>
                            {title}
                        </Text>
                    ))}
                </View>
                {rows.map((row, r) => (
                    <View key={r} style={[styles.row, styles.ruled]}>
                        {header.map((_, i) => (
                            <Text key={i} selectable style={[styles.cell, width(widths[i])]}>
                                {row[i] ?? ''}
                            </Text>
                        ))}
                    </View>
                ))}
            </View>
        </ScrollView>
    );
}
