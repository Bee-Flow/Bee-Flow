/**
 * One version: "v12 · summary", who made it and when, what kind of edit, the
 * net line change, and a Published chip on the snapshot the audience reads.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { Badge, ListRow } from '@/shared/ui';

import type { WebpageVersion } from '../model/buildTypes';
import { actorLabel, lineDeltaLabel, versionSourceLabel, versionTitle } from '../model/versions';

export function VersionRow({
    version,
    onPress,
}: {
    version: WebpageVersion;
    onPress: (version: WebpageVersion) => void;
}) {
    const t = useTranslation();
    const facts = [actorLabel(version), versionSourceLabel(version), lineDeltaLabel(version)].filter(Boolean);
    return (
        <ListRow
            title={versionTitle(version)}
            subtitle={facts.join(' · ')}
            meta={timeAgo(version.createdAt)}
            wrapTitle
            trailing={
                version.isPublished ? (
                    <Badge label={t('webpages.versions.is_published', 'Published')} tone="success" />
                ) : undefined
            }
            onPress={() => onPress(version)}
        />
    );
}
