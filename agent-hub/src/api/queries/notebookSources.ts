// A notebook's sources as the notebook page reads them: asked when a source
// was added or changed, and every few seconds while one is still processing.
// The page keeps the list itself (it edits it optimistically); this reads the
// server's copy through the query cache. Removing a source is a mutation.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { notebookApi } from '../notebookApi';

export function useNotebookSourcesRead<S>() {
    const qc = useQueryClient();
    return useCallback((notebookId: string) => qc.fetchQuery<{ sources?: S[] }>({
        queryKey: ['notebooks', notebookId, 'sources'],
        queryFn: () => notebookApi(`/${notebookId}/sources`) as Promise<{ sources?: S[] }>,
        staleTime: 0,
        retry: false,
    }), [qc]);
}

export function useDeleteNotebookSourceMutation() {
    return useMutation<unknown, Error, { notebookId: string; sourceId: string }>({
        mutationFn: ({ notebookId, sourceId }) => notebookApi(`/${notebookId}/sources/${sourceId}`, { method: 'DELETE' }),
    });
}
