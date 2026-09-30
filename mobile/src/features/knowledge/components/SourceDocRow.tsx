/**
 * One document inside a source — the web's SourceDetail DocRow on a phone:
 * the file, why it was skipped or failed when it was, when it changed, and
 * its status chip (processed, shielded, skipped, failed, duplicate, or
 * processing while an upload settles).
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { documentIcon } from '../model/format';
import { docStatusOf } from '../model/sourceDocuments';
import type { KbDocument } from '../model/types';

export function SourceDocRow({ doc }: { doc: KbDocument }) {
    const t = useTranslation();
    const theme = useTheme();
    const status = docStatusOf(doc);
    const failed = doc.status === 'skipped' || doc.status === 'error';
    return (
        <ListRow
            title={doc.title || t('mobile.knowledge.untitled_document', 'Untitled document')}
            subtitle={(failed ? doc.status_reason : doc.source_uri) || undefined}
            meta={doc.created_at ? timeAgo(doc.created_at, { suffix: true }) : undefined}
            wrapTitle
            leading={<Icon name={documentIcon(doc.source_type)} size={18} color={theme.colors.textMuted} />}
            trailing={status ? <Badge label={t(status.key, status.en)} tone={status.tone} icon={status.icon} /> : undefined}
        />
    );
}
