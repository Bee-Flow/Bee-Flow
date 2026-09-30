/**
 * One notebook in the list. A failed or still-working ingestion shows on the
 * row, because it is the most common reason a notebook answers badly and the
 * card counts are the only place it shows.
 */

import React from 'react';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import type { NotebookCard } from '../model/types';

/** Undefined, not null, when all is well: ListRow keeps its chevron then. */
function ingestBadge(nb: NotebookCard, t: TranslateFn): React.ReactElement | undefined {
    if (nb.failedCount > 0) {
        return <Badge label={t('notebooks.failed_sources', '{count} sources failed', { count: nb.failedCount })} tone="error" />;
    }
    if (nb.processingCount > 0) {
        return (
            <Badge label={t('notebooks.processing_sources', '{count} sources processing', { count: nb.processingCount })} tone="warning" />
        );
    }
    return undefined;
}

export function NotebookRow({
    notebook,
    onPress,
    onLongPress,
}: {
    notebook: NotebookCard;
    onPress: () => void;
    onLongPress: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <ListRow
            title={notebook.name}
            subtitle={
                notebook.description ||
                notebook.preview ||
                t('notebooks.confirm_delete_sources_many', '{count} sources', { count: notebook.sourceCount })
            }
            meta={timeAgo(notebook.lastActivityAt ?? notebook.updatedAt)}
            wrapTitle
            leading={
                <Icon
                    name={notebook.pinned ? 'Bookmark' : 'Book'}
                    size={18}
                    color={notebook.pinned ? theme.colors.accentPrimary : theme.colors.textMuted}
                />
            }
            trailing={ingestBadge(notebook, t)}
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
