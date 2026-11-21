/**
 * Archive a notebook. The phone never deletes one: archived, it keeps its
 * sources, history and chat, and its owner restores it (or deletes it for good)
 * in the Documents library on the web.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useArchiveNotebook } from '../hooks/mutations';
import type { NotebookCard } from '../model/types';

export type ArchivableNotebook = Pick<NotebookCard, 'id' | 'name'>;

export function ArchiveNotebookSheet({
    notebook,
    onDone,
    onArchived,
}: {
    notebook: ArchivableNotebook | null;
    onDone: () => void;
    /** After the archive, e.g. leave the notebook's own screen. */
    onArchived?: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const archive = useArchiveNotebook({
        onSuccess: () => {
            toast(t('doc_followups.notebook_archived', 'Notebook archived'), 'success');
            onDone();
            onArchived?.();
        },
    });

    return (
        <ConfirmSheet
            visible={Boolean(notebook)}
            title={t('doc_followups.archive_notebook_title', 'Archive notebook?')}
            message={t(
                'doc_followups.archive_notebook_body',
                '"{name}" moves to the archive, with its sources, version history and chat. You can restore it in Bee Flow on the web.',
                { name: notebook?.name ?? '' },
            )}
            confirmLabel={t('doc_followups.archive_notebook', 'Archive')}
            tone="primary"
            busy={archive.isPending}
            onCancel={onDone}
            onConfirm={() => notebook && archive.mutate(notebook.id)}
        />
    );
}
