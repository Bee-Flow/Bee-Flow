/**
 * One row of "Recently edited": the kind's tile, the name, which section it
 * is in and when it last changed, and its status chip — in the web's words
 * (studio.recent.status_*) and tones, where "no status" is a neutral word and
 * never a reassuring green.
 */

import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, KindTile, Text, type Tone } from '@/shared/ui';

import { useOpenTarget } from '../hooks/useOpenTarget';
import { sectionTarget } from '../model/links';
import type { RecentEntry, RecentStatus } from '../model/recent';
import { studioSection } from '../model/registry';

/** STATUS_LABELS (recent/recentWork.js): the word and its tone per status. */
const STATUS: Record<RecentStatus, { key: string; fallback: string; tone: Tone }> = {
    failed: { key: 'studio.recent.status_failed', fallback: 'Failed', tone: 'error' },
    processing: { key: 'studio.recent.status_processing', fallback: 'Processing', tone: 'warning' },
    unpublished_changes: { key: 'studio.recent.status_unpublished_changes', fallback: 'Unpublished changes', tone: 'warning' },
    published: { key: 'studio.recent.status_published', fallback: 'Published', tone: 'success' },
    active: { key: 'studio.recent.status_active', fallback: 'On', tone: 'success' },
    ready: { key: 'studio.recent.status_ready', fallback: 'Ready', tone: 'success' },
    draft: { key: 'studio.recent.status_draft', fallback: 'Draft', tone: 'neutral' },
    paused: { key: 'studio.recent.status_paused', fallback: 'Paused', tone: 'neutral' },
    unknown: { key: 'studio.recent.status_unknown', fallback: 'Status unknown', tone: 'neutral' },
    unsupported: { key: 'studio.recent.status_unsupported', fallback: 'No status', tone: 'neutral' },
};

export function RecentRow({ item }: { item: RecentEntry }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const open = useOpenTarget();
    const section = studioSection(item.sectionId);
    const status = STATUS[item.status];
    const name = item.name || t('studio.recent.untitled', 'Untitled');
    const where = t(section.labelKey, section.labelFallback);
    const when = item.updatedAt ? timeAgo(item.updatedAt) : null;
    return (
        <Pressable
            onPress={() => open(sectionTarget(section, item.id))}
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${where}`}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`studio-recent-${item.key}`}
        >
            <KindTile kind={item.kind} size={28} />
            <View style={styles.words}>
                <Text variant="body" numberOfLines={1}>
                    {name}
                </Text>
                <Text variant="label" tone="tertiary" numberOfLines={1}>
                    {when ? `${where} · ${when}` : where}
                </Text>
            </View>
            {item.status === 'unsupported' ? null : <Badge label={t(status.key, status.fallback)} tone={status.tone} />}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        minHeight: 52,
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    words: { flex: 1, gap: 2 } satisfies ViewStyle,
});
