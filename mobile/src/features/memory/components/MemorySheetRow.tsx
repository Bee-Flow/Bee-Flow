/**
 * One row of the Library's memory sheet: the whole line, selectable, its type
 * (accented when the retriever weighs it high) and when it last changed. Only
 * the bin responds to a tap. The Memory screen draws its own MemoryRow, which
 * expands on a tap instead.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, IconButton, Text } from '@/shared/ui';

import { capitalise, memoryLine } from '../model/format';
import type { Memory } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.borderSubtle,
        },
        body: { flex: 1, gap: theme.spacing.xs },
        meta: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    });

export function MemorySheetRow({ memory, onDelete }: { memory: Memory; onDelete: () => void }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <View style={styles.body}>
                <Text variant="body" selectable>
                    {memoryLine(memory)}
                </Text>
                <View style={styles.meta}>
                    <Badge label={capitalise(memory.type)} tone={memory.importance >= 0.8 ? 'accent' : 'neutral'} />
                    <Text variant="label" tone="tertiary">
                        {timeAgo(memory.updated_at)}
                    </Text>
                </View>
            </View>
            <IconButton
                icon={<Icon name="Trash2" size={16} color={theme.colors.textMuted} />}
                accessibilityLabel={`Forget: ${memoryLine(memory).slice(0, 60)}`}
                onPress={onDelete}
            />
        </View>
    );
}
