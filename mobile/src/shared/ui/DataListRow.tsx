/**
 * The pieces of DataList: the header row and a body row, both laid out from
 * ONE `columns` array so the header and the rows cannot drift apart — the
 * web's DataTable (shared/DataTable.jsx) recipe. Exported for a screen that
 * composes its own list (a SectionList, a list with expanding rows).
 */

import React, { memo, type ReactNode } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';
import { TONES, tonePair, type Tone } from './tones';

export interface DataColumn<Row> {
    id: string;
    /** The header word. Rendered uppercase. */
    label: string;
    /** Share of the free width (default 1). Ignored when `width` is set. */
    flex?: number;
    /** A fixed width in dp, for a status or a number column. */
    width?: number;
    align?: 'left' | 'right' | 'center';
    /** The cell. A string or number is drawn as one line of caption text. */
    render: (row: Row) => ReactNode;
}

/** A cell's box: a fixed width, or its flex share; `minWidth: 0` so long text truncates. */
export function columnStyle(column: Pick<DataColumn<unknown>, 'flex' | 'width' | 'align'>): ViewStyle {
    const alignItems = column.align === 'right' ? 'flex-end' : column.align === 'center' ? 'center' : 'flex-start';
    return column.width !== undefined
        ? { width: column.width, alignItems }
        : { flex: column.flex ?? 1, minWidth: 0, alignItems };
}

export function DataListHeader({ columns, cellStyles }: { columns: readonly DataColumn<never>[]; cellStyles: ViewStyle[] }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.header} accessibilityRole="header">
            {columns.map((column, i) => (
                <View key={column.id} style={cellStyles[i]}>
                    <Text variant="label" weight="semibold" style={styles.headerText} numberOfLines={1}>
                        {column.label}
                    </Text>
                </View>
            ))}
        </View>
    );
}

export interface DataListRowProps<Row> {
    row: Row;
    columns: readonly DataColumn<Row>[];
    cellStyles: ViewStyle[];
    onPress?: (row: Row) => void;
    /** A 3px stripe on the leading edge in the tone's raw colour — the row's STATUS. */
    accent?: Tone | null;
    /** What a screen reader says for a tappable row. */
    accessibilityLabel?: string;
    testID?: string;
}

function DataListRowView<Row>({
    row,
    columns,
    cellStyles,
    onPress,
    accent,
    accessibilityLabel,
    testID,
}: DataListRowProps<Row>) {
    const styles = useThemedStyles(makeStyles);
    const cells = columns.map((column, i) => {
        const value = column.render(row);
        return (
            <View key={column.id} style={cellStyles[i]}>
                {typeof value === 'string' || typeof value === 'number' ? (
                    <Text variant="caption" numberOfLines={1}>
                        {String(value)}
                    </Text>
                ) : (
                    value
                )}
            </View>
        );
    });
    const stripe = accent ? styles.stripe[accent] : null;
    if (!onPress) {
        return (
            <View testID={testID} style={[styles.row, stripe]}>
                {cells}
            </View>
        );
    }
    return (
        <Pressable
            testID={testID}
            onPress={() => onPress(row)}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={({ pressed }) => [styles.row, stripe, pressed ? styles.pressed : null]}
        >
            {cells}
        </Pressable>
    );
}

/**
 * A list cell, so memoised: a row whose data, columns and handlers did not
 * change has nothing to redraw when the list around it re-renders.
 */
export const DataListRow = memo(DataListRowView) as typeof DataListRowView;

const makeStyles = (theme: Theme) => ({
    header: {
        flexDirection: 'row',
        gap: theme.spacing[3],
        paddingHorizontal: theme.spacing[3.5],
        paddingVertical: theme.spacing[2],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderDefault,
        // Opaque: DataList pins the header, and rows scroll under it.
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    // The web's 10px uppercase header at the phone's 11px floor, .08em tracking.
    headerText: { color: theme.colors.textTertiary, letterSpacing: 0.88, textTransform: 'uppercase' } satisfies TextStyle,
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        minHeight: 44,
        paddingHorizontal: theme.spacing[3.5],
        paddingVertical: theme.spacing[2.5],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.bgSecondary } satisfies ViewStyle,
    stripe: Object.fromEntries(
        TONES.map((tone) => [tone, { boxShadow: `inset 3px 0 0 ${tonePair(theme.colors, tone).raw}` }]),
    ) as Record<Tone, ViewStyle>,
});
