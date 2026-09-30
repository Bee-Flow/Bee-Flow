/** Knowledge-base queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import {
    getKbDocumentChunks,
    getKnowledgeBase,
    listKbDocuments,
    listKnowledgeBases,
} from '../api/endpoints';
import { knowledgeKeys } from '../api/keys';

/**
 * The user's knowledge bases. One key wherever it is asked for, so the list is
 * fetched once; the chat composer passes `enabled` to fetch only when showing it.
 */
export function useKnowledgeBases(options: { enabled?: boolean; staleTime?: number } = {}) {
    return useQuery({
        queryKey: knowledgeKeys.all,
        queryFn: ({ signal }) => listKnowledgeBases(signal),
        ...options,
    });
}

export function useKnowledgeBase(kbId: string) {
    return useQuery({
        queryKey: knowledgeKeys.base(kbId),
        queryFn: ({ signal }) => getKnowledgeBase(kbId, signal),
        enabled: Boolean(kbId),
    });
}

/**
 * A separate read from the base: the detail response embeds an unpaged
 * document list, and this is the paged endpoint the list actually needs once a
 * base grows past a screenful.
 */
export function useKbDocuments(kbId: string) {
    return useQuery({
        queryKey: knowledgeKeys.documents(kbId),
        queryFn: ({ signal }) => listKbDocuments(kbId, { limit: 200 }, signal),
        enabled: Boolean(kbId),
    });
}

/** The indexed chunks of one document, fetched only while one is being previewed. */
export function useKbChunks(doc: { kbId: string; docId: string } | null) {
    return useQuery({
        queryKey: knowledgeKeys.chunks(doc?.kbId ?? '', doc?.docId ?? ''),
        queryFn: ({ signal }) => getKbDocumentChunks(doc?.kbId ?? '', doc?.docId ?? '', signal),
        enabled: Boolean(doc),
    });
}
