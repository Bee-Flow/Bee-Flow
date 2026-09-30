/**
 * One source of a knowledge base — the web's SourcesTab row: the kind's
 * glyph, the name, its subline ("uploaded · 3 files"), how it refreshes and
 * when it last did, and a failure said as one.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { refreshLabel, sourceIcon, sourceSubline } from '../model/sources';
import type { KbSource } from '../model/types';

export function SourceRow({ source, onPress }: { source: KbSource; onPress: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const updated = source.lastRefreshAt
        ? timeAgo(source.lastRefreshAt, { suffix: true })
        : t('knowledge.sources.never_refreshed', 'never');
    const busy = source.status === 'running' || source.status === 'queued';
    return (
        <ListRow
            title={source.name || sourceSubline(t, source)}
            subtitle={sourceSubline(t, source)}
            meta={`${refreshLabel(t, source)} · ${updated}`}
            wrapTitle
            leading={<Icon name={sourceIcon(source.kind)} size={18} color={theme.colors.textMuted} />}
            trailing={
                source.error ? (
                    <Badge label={t('knowledge.failed', 'Failed')} tone="error" />
                ) : busy ? (
                    <Badge label={t('mobile.knowledge.source_busy', 'Refreshing')} tone="info" />
                ) : undefined
            }
            chevron
            onPress={onPress}
        />
    );
}
