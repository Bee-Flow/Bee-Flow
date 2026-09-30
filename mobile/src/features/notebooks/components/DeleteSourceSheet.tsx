/** Remove one source from a notebook. The notebook keeps its chat and notes. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useDeleteSource } from '../hooks/mutations';
import type { NotebookSource } from '../model/types';

export function DeleteSourceSheet({
    notebookId,
    source,
    onDone,
}: {
    notebookId: string;
    source: NotebookSource | null;
    onDone: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const remove = useDeleteSource(notebookId, {
        onSuccess: () => {
            onDone();
            toast(t('mobile.notebooks.source_removed', 'Source removed'), 'success');
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(source)}
            title={t('notebooks.remove_source', 'Remove source')}
            message={t(
                'mobile.notebooks.remove_source_body',
                '“{name}” and everything indexed from it are deleted. The notebook keeps its chat and notes.',
                { name: source?.name ?? '' },
            )}
            confirmLabel={t('notebooks.remove_source', 'Remove source')}
            busy={remove.isPending}
            onCancel={onDone}
            onConfirm={() => source && remove.mutate(source.id)}
        />
    );
}
