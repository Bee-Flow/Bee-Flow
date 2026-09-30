/**
 * A GFM table, styled as the web's `.markdown-content table`: 1px cell
 * borders, a tinted header row at weight 600, cells padded 0.35rem × 0.6rem
 * in the smaller table type, and a sideways scroll when it is wider than the
 * message (`.table-wrapper`). Column alignment (`:--`, `:-:`, `--:`) is kept.
 */

import type { Tokens } from 'marked';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { RenderCtx } from '@/shared/markdown/render/ctx';
import { plainText, renderInline } from '@/shared/markdown/render/inline';

import { columnWidths, fillWidths } from './tableLayout';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        table: { borderTopWidth: 1, borderLeftWidth: 1, borderColor: theme.colors.borderDefault },
        row: { flexDirection: 'row' },
        cell: {
            paddingVertical: 5,
            paddingHorizontal: 9,
            borderRightWidth: 1,
            borderBottomWidth: 1,
            borderColor: theme.colors.borderDefault,
            justifyContent: 'center',
        },
        head: { backgroundColor: theme.colors.bgTertiary },
        text: { ...theme.type.caption, color: theme.colors.textPrimary },
        headText: { ...theme.fonts.semibold },
    }),
);

const ALIGN: Record<string, TextStyle['textAlign']> = { left: 'left', center: 'center', right: 'right' };

function columnStyle(width: number | undefined): ViewStyle {
    return { width };
}

function alignStyle(align: string | null | undefined): TextStyle {
    return { textAlign: (align && ALIGN[align]) || 'left' };
}

function Row({ cells, widths, head, ctx }: { cells: Tokens.TableCell[]; widths: number[]; head: boolean; ctx: RenderCtx }) {
    const styles = useThemedStyles(sheet);
    return (
        <View style={styles.row}>
            {cells.map((cell, i) => (
                <View key={i} style={[styles.cell, head && styles.head, columnStyle(widths[i])]}>
                    <Text selectable style={[styles.text, head && styles.headText, alignStyle(cell.align)]}>
                        {renderInline(cell.tokens, ctx, `c${i}`)}
                    </Text>
                </View>
            ))}
        </View>
    );
}

export function MarkdownTable({ token, ctx }: { token: Tokens.Table; ctx: RenderCtx }) {
    const styles = useThemedStyles(sheet);
    const [available, setAvailable] = useState(0);
    const natural = columnWidths(
        token.header.map((cell) => plainText(cell.tokens)),
        token.rows.map((row) => row.map((cell) => plainText(cell.tokens))),
    );
    // The table's own left border takes one pixel of the width it may fill.
    const widths = fillWidths(natural, Math.max(0, available - 1));

    return (
        <View onLayout={(e) => setAvailable(Math.floor(e.nativeEvent.layout.width))}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.table}>
                    <Row cells={token.header} widths={widths} head ctx={ctx} />
                    {token.rows.map((row, i) => (
                        <Row key={i} cells={row} widths={widths} head={false} ctx={ctx} />
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}
