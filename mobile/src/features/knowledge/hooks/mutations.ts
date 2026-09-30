/**
 * Knowledge-base writes. Each hook owns its invalidation; the screen passes
 * what should happen on its side (close a sheet, toast) as handlers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
    createKnowledgeBase,
    deleteKbDocument,
    deleteKnowledgeBase,
    searchKnowledgeBases,
} from '../api/endpoints';
import { INGESTED_DOCUMENTS, knowledgeKeys } from '../api/keys';
import type { KnowledgeBase } from '../model/types';

export interface Handlers<D, V> {
    onSuccess?: (data: D, vars: V) => void;
    onError?: (error: Error, vars: V) => void;
}

/**
 * Everything a change to a base's documents makes stale: the bases (and,
 * through the prefix, every base's own document list and chunks) and the
 * cross-base document views built from them.
 */
export function useRefreshKnowledge(): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: INGESTED_DOCUMENTS });
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    }, [queryClient]);
}

export function useCreateKnowledgeBase(
    handlers: Handlers<KnowledgeBase | null, { name: string; description: string }> = {},
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (input: { name: string; description: string }) => createKnowledgeBase(input),
        onSuccess: (kb, vars) => {
            void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
            handlers.onSuccess?.(kb, vars);
        },
    });
}

export interface KbDeletion {
    kb: KnowledgeBase;
    /** True only once the guard's 409 answer has been shown. */
    confirmed: boolean;
}

export function useDeleteKnowledgeBase(handlers: Handlers<void, KbDeletion> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ kb, confirmed }: KbDeletion) =>
            deleteKnowledgeBase(kb.id, { confirmedBreaking: confirmed }),
        onSuccess: (_result, vars) => {
            handlers.onSuccess?.(undefined, vars);
            void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
        },
        onError: handlers.onError,
    });
}

export function useDeleteKbDocument(handlers: Handlers<void, { kbId: string; docId: string }> = {}) {
    const refresh = useRefreshKnowledge();
    return useMutation({
        mutationFn: ({ kbId, docId }: { kbId: string; docId: string }) => deleteKbDocument(kbId, docId),
        onSuccess: (_result, vars) => {
            handlers.onSuccess?.(undefined, vars);
            refresh();
        },
    });
}

/**
 * Retrieval as a mutation: it is run on demand from a search box, never
 * cached, and a second identical question should ask the server again.
 */
export function useKbSearch(kbId: string | undefined) {
    return useMutation({
        mutationFn: (query: string) => searchKnowledgeBases(query, kbId ? [kbId] : [], 8),
    });
}
