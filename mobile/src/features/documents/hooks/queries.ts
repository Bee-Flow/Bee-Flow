/** Document queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import type { KnowledgeBase } from '@/features/knowledge';

import { listDocumentsAcrossBases, listRenderedDocuments } from '../api/endpoints';
import { documentKeys } from '../api/keys';

/**
 * Documents fanned out over `bases`. `scope` keeps the hub's short list
 * (a few bases, a few rows each) apart from the full screen's.
 */
export function useDocumentsAcross(
    scope: string,
    bases: KnowledgeBase[],
    options: { enabled: boolean; maxBases?: number; perBase?: number },
) {
    const { enabled, maxBases, perBase } = options;
    return useQuery({
        queryKey: documentKeys.across(scope, bases.map((kb) => kb.id).join(',')),
        queryFn: ({ signal }) => listDocumentsAcrossBases(bases, { maxBases, perBase }, signal),
        enabled,
    });
}

/** Generated PDFs. Fetched only once their tab is open. */
export function useRenderedDocuments(enabled: boolean) {
    return useQuery({
        queryKey: documentKeys.rendered,
        queryFn: ({ signal }) => listRenderedDocuments(signal),
        enabled,
    });
}
