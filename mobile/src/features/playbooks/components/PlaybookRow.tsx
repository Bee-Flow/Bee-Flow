/**
 * One playbook in the list — the web's PlaybookCard. It answers the three
 * things a person asks of a build without opening it: how far is it, is it
 * waiting for me, and what is it.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KindTile, Text } from '@/shared/ui';

import { playbookStatus, phaseLabel } from '../model/playbookView';
import type { PlaybookSummary } from '../model/types';
import { VIEW_TONE_TEXT } from '../model/viewTone';

function metaLine(pb: PlaybookSummary, t: TranslateFn): string {
    const current = pb.phases.find((p) => p.key === pb.currentPhase) ?? (pb.currentPhase ? { key: pb.currentPhase, kind: null, label: null } : null);
    return [
        // An AI-written recipe's title IS the playbook's title: never twice.
        pb.recipeLabel && pb.recipeLabel !== pb.title ? pb.recipeLabel : null,
        t('playbooks.progress', '{done}/{total} phases', { done: pb.progress.done, total: pb.progress.total }),
        current && pb.status === 'active' ? phaseLabel(current, t) : null,
        timeAgo(pb.updatedAt, { suffix: true }) || null,
    ]
        .filter(Boolean)
        .join(' · ');
}

export function PlaybookRow({ playbook, onOpen }: { playbook: PlaybookSummary; onOpen: (id: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const status = playbookStatus(playbook, t);
    return (
        <Pressable
            onPress={() => onOpen(playbook.id)}
            accessibilityRole="button"
            accessibilityLabel={`${playbook.title}. ${status.text}`}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`playbook-row-${playbook.id}`}
        >
            <KindTile kind="playbook" size={36} />
            <View style={styles.body}>
                <Text variant="subheading" numberOfLines={1}>
                    {playbook.title}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={2}>
                    {metaLine(playbook, t)}
                </Text>
                <Text variant="label" tone={VIEW_TONE_TEXT[status.tone]} weight="semibold">
                    {status.text}
                </Text>
            </View>
            <Icon name="ChevronRight" size={18} color={styles.chevron.color} />
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing[3],
        minHeight: 72,
        paddingHorizontal: theme.spacing[4],
        paddingVertical: theme.spacing[3],
    },
    pressed: { backgroundColor: theme.colors.itemHoverBg },
    body: { flex: 1, gap: theme.spacing[0.5] },
    chevron: { color: theme.colors.textMuted },
});
