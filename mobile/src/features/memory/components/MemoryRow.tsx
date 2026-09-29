/**
 * One thing Bee Flow remembers.
 *
 * Built around inspection rather than management: the whole point of a memory
 * screen is that a person can read exactly what was stored about them, so a
 * tap expands the row to its full text instead of opening a detail screen, and
 * the forget button sits on the row rather than behind a menu. Nothing here is
 * more than one tap from being deleted, which is the correct distance for a
 * privacy product.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import { relativeTime } from '../../../lib/time';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { IconButton } from '../../../ui/Button';
import { Text } from '../../../ui/Text';
import { memoryLine } from '../api';
import { importanceLabel, memoryTypeLabel, type Memory } from '../types';

export function MemoryRow({
    memory,
    expanded,
    selecting,
    selected,
    onPress,
    onLongPress,
    onDelete,
}: {
    memory: Memory;
    expanded: boolean;
    selecting: boolean;
    selected: boolean;
    onPress: () => void;
    onLongPress: () => void;
    onDelete: () => void;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const line = memoryLine(memory);
    const importance = importanceLabel(memory.importance);

    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole={selecting ? 'checkbox' : 'button'}
            accessibilityLabel={line}
            accessibilityHint={
                selecting
                    ? 'Double tap to select or deselect'
                    : expanded
                      ? 'Double tap to collapse'
                      : 'Double tap to read it in full'
            }
            accessibilityState={selecting ? { checked: selected } : { expanded }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                minHeight: 64,
                backgroundColor: selected
                    ? theme.colors.itemActiveBg
                    : pressed
                      ? theme.colors.itemHoverBg
                      : 'transparent',
            })}
        >
            {selecting ? (
                <View
                    style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        marginTop: 2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: selected ? theme.colors.accentPrimary : theme.colors.borderDefault,
                        backgroundColor: selected ? theme.colors.accentPrimary : 'transparent',
                    }}
                >
                    {selected ? (
                        <Feather name="check" size={14} color={theme.colors.accentPrimaryFg} />
                    ) : null}
                </View>
            ) : null}

            <View style={{ flex: 1, gap: theme.spacing.xs }}>
                <Text variant="body" numberOfLines={expanded ? undefined : 3}>
                    {line}
                </Text>
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: theme.spacing.xs,
                    }}
                >
                    <Badge label={memoryTypeLabel(memory.type)} />
                    {importance === 'High' ? (
                        <Badge label={t('mobile.memory.weighted_high', 'Weighted high')} tone="accent" />
                    ) : null}
                    {memory.agent_id ? (
                        <Badge label={t('mobile.memory.one_agent_only', 'One agent only')} />
                    ) : null}
                    <Text variant="label" tone="tertiary">
                        {relativeTime(memory.updated_at || memory.created_at, { suffix: true })}
                    </Text>
                </View>
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
                    icon={<Feather name="trash-2" size={18} color={theme.colors.textMuted} />}
                    accessibilityLabel={`Forget: ${line.slice(0, 60)}`}
                    tone="destructive"
                    onPress={onDelete}
                />
            )}
        </Pressable>
    );
}
