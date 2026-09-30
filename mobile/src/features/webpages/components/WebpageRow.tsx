/**
 * One page in the list: its glyph, name, tagline and whether colleagues can
 * see it. It no longer guesses "empty" from the three slot sizes: a React +
 * Material UI page — the default for a new one — keeps its app in project
 * files the list row does not count, so a built page read as never built.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { Badge, KindTile, ListRow } from '@/shared/ui';

import type { Webpage } from '../model/types';

function StateBadge({ page }: { page: Webpage }) {
    const t = useTranslation();
    if (page.isPublished) return <Badge label={t('studio.status.published', 'Published')} tone="success" />;
    return <Badge label={t('studio.status.draft', 'Draft')} tone="neutral" />;
}

export function WebpageRow({ page, onPress }: { page: Webpage; onPress: () => void }) {
    const t = useTranslation();
    return (
        <ListRow
            title={page.name || t('mobile.webpages.untitled', 'Untitled page')}
            subtitle={page.tagline || page.description || undefined}
            meta={timeAgo(page.updatedAt)}
            wrapTitle
            leading={<KindTile kind="webpage" icon={page.icon || null} size={36} />}
            trailing={<StateBadge page={page} />}
            onPress={onPress}
        />
    );
}
