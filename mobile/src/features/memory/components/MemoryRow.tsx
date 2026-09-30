/**
 * One thing Bee Flow remembers, as the Memory screen draws it (the Library's
 * memory sheet has its own MemorySheetRow).
 *
 * Built around inspection rather than management: a tap expands the row to
 * its full text instead of opening a detail screen, and the forget button sits
 * on the row rather than behind a menu. Nothing here is more than one tap from
 * being deleted, which is the correct distance for a privacy product.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

import { MemoryCheck } from './MemoryCheck';
import { MemoryMeta } from './MemoryMeta';
import { memoryLine } from '../model/format';
import type { Memory } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            minHeight: 64,
        },
        body: { flex: 1, gap: theme.spacing.xs },
    });

function hintFor(selecting: boolean, expanded: boolean): string {
    if (selecting) return 'Double tap to select or deselect';
    return expanded ? 'Double tap to collapse' : 'Double tap to read it in full';
}

export function MemoryRow({
    memory,
    expanded,
    selecting = false,
    selected = false,
    onPress,
    onLongPress,
    onDelete,
}: {
    memory: Memory;
    expanded: boolean;
    /** Selection mode: the row toggles instead of expanding, and hides its bin. */
    selecting?: boolean;
    selected?: boolean;
    onPress: () => void;
    onLongPress?: () => void;
    onDelete: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const line = memoryLine(memory);
    const idle = selected ? theme.colors.itemActiveBg : 'transparent';

    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole={selecting ? 'checkbox' : 'button'}
            accessibilityLabel={line}
            accessibilityHint={hintFor(selecting, expanded)}
            accessibilityState={selecting ? { checked: selected } : { expanded }}
            style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed && !selected ? theme.colors.itemHoverBg : idle },
            ]}
        >
            {selecting ? <MemoryCheck checked={selected} /> : null}

            <View style={styles.body}>
                <Text variant="body" numberOfLines={expanded ? undefined : 3}>
                    {line}
                </Text>
                <MemoryMeta memory={memory} />
                {/* The summary is what the list shows; the original sentence is
                    what was actually said, and only the expanded row owes it. */}
                {expanded && memory.summary?.trim() && memory.summary.trim() !== memory.content ? (
                    <Text variant="caption" tone="tertiary">
                        {memory.content}
                    </Text>
                ) : null}
            </View>

            {selecting ? null : (
                <IconButton
                    icon={<Icon name="Trash2" size={18} color={theme.colors.textMuted} />}
                    accessibilityLabel={`Forget: ${line.slice(0, 60)}`}
                    tone="danger"
                    onPress={onDelete}
                />
            )}
        </Pressable>
    );
}
