/**
 * What the assistant did for this answer, while it does it (the web's
 * ChatActivity.jsx): a numbered row per tool call — the live one spinning,
 * finished ones ticked, a failure in words — with the total time in the
 * header. A tap on a row opens its raw input and result.
 *
 * The card stays after the turn: the tools are the story of the answer, not
 * debugging output.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { describeTool, formatDurationMs, visibleTools } from '@/features/chat/model/toolDisplay';
import type { ChatMessage, ToolActivity } from '@/features/chat/model/types';
import { Icon, Spinner, Text } from '@/shared/ui';

import { ActivityRow } from './ActivityRow';
import { ToolOutputSheet } from './ToolOutputSheet';

const makeStyles = (theme: Theme) => ({
    card: {
        marginBottom: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgSecondary,
        padding: theme.spacing[2.5],
    },
    header: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[1.5], marginBottom: theme.spacing[1.5] },
    failed: { marginLeft: 'auto' as const, flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.xs },
});

export function ActivityCard({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState<ToolActivity | null>(null);
    const tools = visibleTools(message.tools);
    if (tools.length === 0) return null;

    const streaming = Boolean(message.streaming);
    const rows = tools.map((tool) => describeTool(tool, { streaming }));
    const failed = rows.filter((row) => row.status === 'failed').length;
    const total = formatDurationMs(rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0) || null);

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                {streaming ? <Spinner /> : <Icon name="Wrench" size={13} color={theme.colors.textSecondary} />}
                <Text variant="caption" tone="secondary" weight="medium">
                    {streaming ? t('chat.act.working', 'Working') : t('chat.msg.tools_used', 'Tools Used')}
                </Text>
                <Text variant="label" tone="tertiary">
                    {String(rows.length)}
                </Text>
                {!streaming && total ? (
                    <Text variant="label" tone="tertiary">
                        {total}
                    </Text>
                ) : null}
                {failed > 0 ? (
                    <View style={styles.failed}>
                        <Icon name="TriangleAlert" size={11} color={theme.colors.warning} />
                        <Text variant="label" tone="warning">
                            {t('chat.act.failed_count', '{n} failed', { n: failed })}
                        </Text>
                    </View>
                ) : null}
            </View>
            {rows.map((row, index) => (
                <ActivityRow key={tools[index]?.id ?? index} n={index + 1} row={row} onOpen={() => setOpen(tools[index] ?? null)} />
            ))}
            <ToolOutputSheet tool={open} onClose={() => setOpen(null)} />
        </View>
    );
}
