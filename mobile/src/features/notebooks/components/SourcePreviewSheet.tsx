/** A source's extracted text — what the model reads, not the original file. */

import React from 'react';

import { shareText } from '@/core/api/shareFile';
import { useTranslation } from '@/core/i18n';
import { PreviewSheet } from '@/features/knowledge';

import { useSourceContent } from '../hooks/queries';
import type { NotebookSource } from '../model/types';

export function SourcePreviewSheet({
    notebookId,
    source,
    onClose,
}: {
    notebookId: string;
    source: NotebookSource | null;
    onClose: () => void;
}) {
    const t = useTranslation();
    const preview = useSourceContent(notebookId, source ? source.id : null);
    const content = preview.data?.content ?? '';

    return (
        <PreviewSheet
            visible={Boolean(source)}
            onClose={onClose}
            title={source?.name ?? ''}
            subtitle={t('mobile.notebooks.extracted_text', 'The extracted text — this is what the model reads')}
            // URL sources are stored as converted markdown; everything else is
            // plain extracted text.
            kind={source?.type === 'url' ? 'markdown' : 'text'}
            content={content}
            loading={preview.isLoading}
            error={preview.isError ? preview.error : undefined}
            onRetry={() => void preview.refetch()}
            onShare={content ? () => void shareText(content, source?.name ?? t('notebooks.source', 'Source')) : undefined}
        />
    );
}
