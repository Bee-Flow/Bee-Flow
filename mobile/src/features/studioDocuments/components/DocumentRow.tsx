/**
 * One document in the library, as the web lists it: the page or deck glyph,
 * the name, "type · date · visibility", the categories, and the row's own
 * actions behind the overflow button.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, ListRow } from '@/shared/ui';

import { docIcon, docTypeLabel } from '../model/format';
import type { StudioDocumentRow } from '../model/types';

export interface DocumentRowProps {
    row: StudioDocumentRow;
    onOpen: (row: StudioDocumentRow) => void;
    onMore: (row: StudioDocumentRow) => void;
}

export function DocumentRow({ row, onOpen, onMore }: DocumentRowProps) {
    const t = useTranslation();
    const theme = useTheme();
    const visibility = row.visibility === 'team' ? t('mobile.studio_documents.team', 'Team') : t('mobile.studio_documents.private', 'Private');
    const categories = row.categories.length ? ` · ${row.categories.join(' · ')}` : '';
    return (
        <ListRow
            title={row.name || t('documents.untitled', 'Untitled document')}
            subtitle={`${docTypeLabel(t, row.docType)} · ${visibility}${categories}`}
            meta={timeAgo(row.updatedAt)}
            wrapTitle
            chevron={false}
            leading={<Icon name={docIcon(row)} size={20} color={theme.colors.accentText} />}
            trailing={
                <IconButton
                    icon={<Icon name="MoreVertical" size={18} color={theme.colors.textSecondary} />}
                    accessibilityLabel={t('mobile.studio_documents.row_actions', 'Actions for {name}', { name: row.name })}
                    onPress={() => onMore(row)}
                />
            }
            onPress={() => onOpen(row)}
            onLongPress={() => onMore(row)}
            testID={`studio-document-${row.id}`}
        />
    );
}
