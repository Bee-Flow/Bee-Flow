/**
 * One document inside a knowledge base: tap to read its chunks, hold to
 * delete — or, while documents are being selected, tap to (de)select it.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { documentIcon } from '../model/format';
import type { KbDocument } from '../model/types';

export function KbDocumentRow({
    doc,
    selected,
    onPress,
    onLongPress,
}: {
    doc: KbDocument;
    /** Defined only while selecting: the row then shows a check box. */
    selected?: boolean;
    onPress: () => void;
    onLongPress: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const selecting = selected !== undefined;
    const glyph = selecting ? (selected ? 'SquareCheckBig' : 'Square') : documentIcon(doc.source_type);
    return (
        <ListRow
            title={doc.title || t('mobile.knowledge.untitled_document', 'Untitled document')}
            subtitle={doc.source_uri || undefined}
            meta={timeAgo(doc.created_at)}
            wrapTitle
            selected={selected}
            leading={<Icon name={glyph} size={18} color={selected ? theme.colors.accentText : theme.colors.textMuted} />}
            trailing={
                doc.chunk_count > 0 ? (
                    <Badge label={nOf(t, 'mobile.knowledge.passages', doc.chunk_count, ['{count} passage', '{count} passages'])} />
                ) : (
                    <Badge label={t('mobile.knowledge.not_indexed', 'Not indexed')} tone="warning" />
                )
            }
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
