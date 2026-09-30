/** Delete a notebook, with everything built from its sources — in the web's words. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useDeleteNotebook } from '../hooks/mutations';
import type { NotebookCard } from '../model/types';

export type DeletableNotebook = Pick<NotebookCard, 'id' | 'name' | 'sourceCount'>;

function useSourcesPhrase(count: number): string {
    const t = useTranslation();
    if (count === 0) return t('notebooks.confirm_delete_sources_none', 'no sources');
    if (count === 1) return t('notebooks.confirm_delete_sources_one', '1 source');
    return t('notebooks.confirm_delete_sources_many', '{count} sources', { count });
}

export function DeleteNotebookSheet({
    notebook,
    onDone,
    onDeleted,
}: {
    notebook: DeletableNotebook | null;
    onDone: () => void;
    /** After the delete, e.g. leave the notebook's own screen. */
    onDeleted?: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const sources = useSourcesPhrase(notebook?.sourceCount ?? 0);
    const remove = useDeleteNotebook({
        onSuccess: () => {
            toast(t('mobile.notebooks.deleted', 'Notebook deleted'), 'success');
            onDone();
            onDeleted?.();
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(notebook)}
            title={t('notebooks.confirm_delete_title', 'Delete notebook?')}
            message={t(
                'notebooks.confirm_delete_body',
                '"{name}" will be permanently deleted, along with {sources}, its version history and the chat in this notebook. This can\'t be undone.',
                { name: notebook?.name ?? '', sources },
            )}
            confirmLabel={t('notebooks.delete', 'Delete')}
            busy={remove.isPending}
            onCancel={onDone}
            onConfirm={() => notebook && remove.mutate(notebook.id)}
        />
    );
}
