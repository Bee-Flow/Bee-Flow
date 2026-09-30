/**
 * One row of the output tree (jsonTree.ts): the key, indented to its depth,
 * and its value on one line. A container opens and closes on a tap; a long
 * press copies the row's value. A `readable` row is set in the body face
 * rather than as code: its key and preview are words, not JSON.
 */

import React from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import type { TreeRow } from './jsonTree';

export function JsonRow({
    row,
    onToggle,
    onCopy,
    readable = false,
}: {
    row: TreeRow;
    onToggle: (id: string) => void;
    onCopy: (row: TreeRow) => void;
    readable?: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const container = row.childCount > 0;
    const indent: ViewStyle = { paddingLeft: 12 + Math.min(row.depth, 6) * 14 };
    return (
        <Pressable
            onPress={() => (container ? onToggle(row.id) : onCopy(row))}
            onLongPress={() => onCopy(row)}
            accessibilityRole="button"
            accessibilityState={container ? { expanded: row.expanded } : undefined}
            accessibilityLabel={`${row.key || t('routines.ndv.output_word', 'output')}: ${row.preview}`}
            accessibilityHint={container ? undefined : t('common.copy', 'Copy')}
            style={({ pressed }) => [styles.row, indent, pressed ? styles.pressed : null]}
        >
            <View style={styles.chevron}>
                {container ? <Icon name={row.expanded ? 'ChevronDown' : 'ChevronRight'} size={14} color={styles.glyph.color} /> : null}
            </View>
            {row.key ? (
                <Text variant={readable ? 'caption' : 'code'} weight={readable ? 'medium' : undefined} style={styles.key} numberOfLines={1}>
                    {row.key}
                </Text>
            ) : null}
            <Text
                variant={readable ? 'caption' : 'code'}
                tone={row.kind === 'string' && !readable ? 'success' : 'secondary'}
                style={styles.value}
                numberOfLines={container ? 1 : 3}
            >
                {row.preview}
            </Text>
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.sm,
        minHeight: 36,
        paddingVertical: theme.spacing.xs,
        paddingRight: theme.spacing.md,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    chevron: { width: 14, paddingTop: 3 } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    key: { color: theme.colors.textPrimary, flexShrink: 0, maxWidth: '45%' } satisfies TextStyle,
    value: { flex: 1 } satisfies TextStyle,
});
