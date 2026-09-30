/** One tool call in the activity card: number, name, what it was for, time and status. */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatDurationMs, type ToolRow } from '@/features/chat/model/toolDisplay';
import { Icon, Spinner, Text, type IconName } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, minHeight: 36 },
    badge: {
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        backgroundColor: theme.colors.bgTertiary,
    },
    words: { flex: 1, flexDirection: 'row' as const, gap: theme.spacing[1.5], alignItems: 'baseline' as const },
    detail: { flexShrink: 1 },
    error: {
        marginLeft: 26,
        marginBottom: theme.spacing.xs,
        borderRadius: theme.radii.sm,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing[1.5],
        backgroundColor: theme.colors.bgTertiary,
    },
});

const GLYPH: Record<Exclude<ToolRow['status'], 'running'>, IconName> = {
    done: 'Check',
    failed: 'TriangleAlert',
    interrupted: 'Minus',
};

export function ActivityRow({ n, row, onOpen }: { n: number; row: ToolRow; onOpen: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const duration = formatDurationMs(row.durationMs);
    const glyphColor =
        row.status === 'failed' ? theme.colors.warning : row.status === 'done' ? theme.colors.success : theme.colors.textMuted;

    return (
        <View>
            <Pressable
                onPress={onOpen}
                accessibilityRole="button"
                accessibilityLabel={`${n}. ${row.title}${row.detail ? `, ${row.detail}` : ''}`}
                accessibilityHint={t('chat.msg.tool_output_of', 'Tool Output: {name}', { name: row.title })}
                style={styles.row}
            >
                <View style={styles.badge}>
                    <Text variant="label" tone="tertiary">
                        {String(n)}
                    </Text>
                </View>
                <View style={styles.words}>
                    <Text variant="caption" weight="medium" numberOfLines={1}>
                        {row.title}
                    </Text>
                    {row.detail ? (
                        <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.detail}>
                            {row.detail}
                        </Text>
                    ) : null}
                </View>
                {duration ? (
                    <Text variant="label" tone="tertiary">
                        {duration}
                    </Text>
                ) : null}
                {row.status === 'running' ? <Spinner /> : <Icon name={GLYPH[row.status]} size={12} color={glyphColor} />}
            </Pressable>
            {row.error ? (
                <View style={styles.error}>
                    <Text variant="caption">{row.error}</Text>
                </View>
            ) : null}
        </View>
    );
}
