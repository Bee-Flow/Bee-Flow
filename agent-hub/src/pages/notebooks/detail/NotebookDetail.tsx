/**
 * NotebookDetail — opens one notebook. The page navigates at once and shows a
 * skeleton while the notebook loads; a notebook that cannot be opened says
 * why (gone or no longer shared, versus a failure worth retrying) instead of
 * bouncing back to the grid with a toast.
 */
import React, { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notebookKeys, useNotebookDetail } from '../notebookQueries';
import { NotebookLoadError, NotebookSkeleton } from './NotebookSkeleton';
import NotebookEditorView from './NotebookEditorView';

interface Props {
    notebookId: string;
    user: any;
    onBack: () => void;
    onListChanged: () => void;
    onOpenProject: (projectId: string) => void;
}

export default function NotebookDetail({ notebookId, user, onBack, onListChanged, onOpenProject }: Props) {
    const detail = useNotebookDetail(notebookId);
    const qc = useQueryClient();
    const [generation, setGeneration] = useState(0);
    // Reopen: read the notebook again and mount a fresh editor on it.
    const reload = useCallback(() => {
        qc.removeQueries({ queryKey: notebookKeys.detail(notebookId) });
        qc.removeQueries({ queryKey: notebookKeys.conversation(notebookId) });
        setGeneration((n) => n + 1);
        void detail.refetch();
    }, [qc, notebookId, detail]);

    if (detail.isPending) return <NotebookSkeleton onBack={onBack} />;
    if (detail.isError || !detail.data?.notebook?.id) {
        const err = detail.error as { status?: number; message?: string } | null;
        return <NotebookLoadError status={err?.status} message={err?.message} onBack={onBack} onRetry={() => { void detail.refetch(); }} />;
    }
    return (
        <NotebookEditorView
            key={`${notebookId}:${generation}`}
            data={detail.data}
            user={user}
            onBack={onBack}
            onListChanged={onListChanged}
            onOpenProject={onOpenProject}
            onReload={reload}
        />
    );
}
