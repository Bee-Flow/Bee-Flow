/** One indexed document, named with the knowledge base it lives in. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { documentIcon } from '@/features/knowledge';
import { Badge, Icon, ListRow } from '@/shared/ui';

import type { OwnedDocument } from '../model/types';

export function OwnedDocumentRow({
    doc,
    onPress,
    onLongPress,
}: {
    doc: OwnedDocument;
    onPress: () => void;
    onLongPress: () => void;
}) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    return (
        <ListRow
            title={doc.title || 'Untitled document'}
            subtitle={doc.kbName}
            meta={timeAgo(doc.created_at)}
            wrapTitle
            leading={<Icon name={documentIcon(doc.source_type)} size={18} color={theme.colors.textMuted} />}
            trailing={
                doc.chunk_count > 0 ? (
                    <Badge label={`${doc.chunk_count}`} />
                ) : (
                    <Badge label="Not indexed" tone="warning" />
                )
            }
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
