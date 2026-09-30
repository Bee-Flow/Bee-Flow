/**
 * Every sheet the notebook screen opens: adding a source (file, camera scan,
 * link, pasted text), previewing, renaming and removing one, and renaming or
 * deleting the notebook itself. `useNotebookSheets` holds which one is open.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { IngestSheets, type IngestFlow } from '@/features/knowledge';

import { DeleteNotebookSheet } from './DeleteNotebookSheet';
import { DeleteSourceSheet } from './DeleteSourceSheet';
import { RenameSheet } from './RenameSheet';
import { SourcePreviewSheet } from './SourcePreviewSheet';
import { useRenameNotebook, useRenameSource } from '../hooks/mutations';
import type { Notebook, NotebookSource } from '../model/types';

export function useNotebookSheets() {
    const [previewOf, setPreviewOf] = useState<NotebookSource | null>(null);
    const [removing, setRemoving] = useState<NotebookSource | null>(null);
    const [renamingSource, setRenamingSource] = useState<NotebookSource | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    return {
        previewOf,
        setPreviewOf,
        removing,
        setRemoving,
        renamingSource,
        setRenamingSource,
        renaming,
        setRenaming,
        deleting,
        setDeleting,
    };
}

export type NotebookSheetState = ReturnType<typeof useNotebookSheets>;

function RenameSheets({ notebookId, notebook, sheets }: { notebookId: string; notebook: Notebook | null; sheets: NotebookSheetState }) {
    const renameNotebook = useRenameNotebook(notebookId, { onSuccess: () => sheets.setRenaming(false) });
    const renameSource = useRenameSource(notebookId, { onSuccess: () => sheets.setRenamingSource(null) });
    return (
        <>
            <RenameSheet
                name={sheets.renaming && notebook ? notebook.name : null}
                busy={renameNotebook.isPending}
                error={renameNotebook.error}
                onSubmit={(name) => renameNotebook.mutate(name)}
                onClose={() => {
                    renameNotebook.reset();
                    sheets.setRenaming(false);
                }}
            />
            <RenameSheet
                name={sheets.renamingSource?.name ?? null}
                busy={renameSource.isPending}
                error={renameSource.error}
                onSubmit={(name) => sheets.renamingSource && renameSource.mutate({ sourceId: sheets.renamingSource.id, name })}
                onClose={() => {
                    renameSource.reset();
                    sheets.setRenamingSource(null);
                }}
            />
        </>
    );
}

export function NotebookSheets({
    notebookId,
    notebook,
    flow,
    sheets,
}: {
    notebookId: string;
    notebook: Notebook | null;
    flow: IngestFlow;
    sheets: NotebookSheetState;
}) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <>
            <IngestSheets
                flow={flow}
                title={t('notebooks.add_source', 'Add Source')}
                subtitle={notebook?.name}
                accepts={t('mobile.notebooks.accepts', 'PDF, Word, Excel, CSV, text or a photo · up to 50 MB')}
                scanName={notebook?.name ? t('mobile.notebooks.scan_name', '{name} scan', { name: notebook.name }) : undefined}
            />
            <SourcePreviewSheet notebookId={notebookId} source={sheets.previewOf} onClose={() => sheets.setPreviewOf(null)} />
            <DeleteSourceSheet notebookId={notebookId} source={sheets.removing} onDone={() => sheets.setRemoving(null)} />
            <RenameSheets notebookId={notebookId} notebook={notebook} sheets={sheets} />
            <DeleteNotebookSheet
                notebook={sheets.deleting && notebook ? notebook : null}
                onDone={() => sheets.setDeleting(false)}
                onDeleted={() => router.back()}
            />
        </>
    );
}
