/**
 * Everything the Library hub reads: the four collections, the search over
 * them, and one refresh for all of it.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useDocumentsAcross } from '@/features/documents';
import { useKnowledgeBases } from '@/features/knowledge';
import { useNotebookSearch } from '@/features/notebooks';
import { useTemplates } from '@/features/templates';
import { useUserRefresh } from '@/shared/patterns';

import { libraryKeys } from '../api/keys';
import { buildHits } from '../model/hits';

export function useLibraryHub(term: string) {
    const queryClient = useQueryClient();
    const notebooks = useNotebookSearch(term);
    const bases = useKnowledgeBases();
    const templates = useTemplates();
    // Documents have no cross-KB endpoint, so the hub fans out over the few
    // most recent knowledge bases only. The full screen widens the net.
    const documents = useDocumentsAcross('hub', bases.data ?? [], {
        enabled: bases.isSuccess,
        maxBases: 4,
        perBase: 10,
    });

    const hits = useMemo(
        () =>
            buildHits(term, {
                notebooks: notebooks.data?.notebooks ?? [],
                bases: bases.data ?? [],
                documents: documents.data?.documents ?? [],
                templates: templates.data ?? [],
            }),
        [term, notebooks.data, bases.data, documents.data, templates.data],
    );

    // The person's pull only: a background refetch of any collection is not one.
    const { refreshing, onRefresh: refreshAll } = useUserRefresh(() =>
        queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
    );

    return { notebooks, bases, templates, documents, hits, refreshing, refreshAll };
}
