/**
 * A knowledge base's sources: the list, and every change to it. Each write
 * re-reads every knowledge base (the list's counts and "Updated" chip move
 * too) and the cross-base document views, because a source write adds or
 * removes documents. It does so on settle, not only on success: a delete
 * that answers 409 `purge_incomplete` has already removed some documents.
 * The screen passes its own feedback as handlers.
 */

import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';

import { useRefreshKnowledge } from './mutations';
import { knowledgeKeys } from '../api/keys';
import {
    createKbSource,
    deleteKbSource,
    ingestKbSitemap,
    ingestKbWorkflow,
    listIngestibleWorkflows,
    listKbSources,
    listSourceDocuments,
    refreshKbSource,
    updateKbSource,
    type NewSource,
    type SitemapResult,
} from '../api/sourceEndpoints';
import { isPendingDoc, nextDocOffset, type SourceDocFilter } from '../model/sourceDocuments';
import type { RefreshRule } from '../model/types';

/** How often a source's documents are re-read while one is still being processed (the web's poll). */
const PENDING_POLL_MS = 3000;

export function useKbSources(kbId: string) {
    return useQuery({
        queryKey: knowledgeKeys.sources(kbId),
        queryFn: ({ signal }) => listKbSources(kbId, signal),
        enabled: Boolean(kbId),
    });
}

/**
 * One source's documents, paged as the list scrolls. While any row is still
 * queued the pages are re-read every few seconds — the list is the progress
 * bar — and the polling stops once nothing is pending.
 */
export function useSourceDocuments(kbId: string, sid: string | null, filter: SourceDocFilter, q: string) {
    return useInfiniteQuery({
        queryKey: knowledgeKeys.sourceDocuments(kbId, sid ?? '', filter, q),
        queryFn: ({ pageParam, signal }) => listSourceDocuments(kbId, sid ?? '', { filter, q, offset: pageParam }, signal),
        initialPageParam: 0,
        getNextPageParam: nextDocOffset,
        enabled: Boolean(kbId && sid),
        refetchInterval: (query) => (query.state.data?.pages.some((p) => p.documents.some(isPendingDoc)) ? PENDING_POLL_MS : false),
    });
}

export function useIngestibleWorkflows(enabled: boolean) {
    return useQuery({
        queryKey: knowledgeKeys.workflows,
        queryFn: ({ signal }) => listIngestibleWorkflows(signal),
        enabled,
    });
}

interface Handlers<D> {
    onSuccess?: (data: D) => void;
    onError?: (error: Error) => void;
}

/** One mutation per change, all refreshing the same things. */
function useSourceWrite<V, D>(kbId: string, write: (vars: V) => Promise<D>, handlers: Handlers<D>) {
    const refresh = useRefreshKnowledge();
    return useMutation({
        mutationFn: write,
        onSuccess: (data) => handlers.onSuccess?.(data),
        onError: handlers.onError,
        onSettled: refresh,
    });
}

export function useCreateKbSource(kbId: string, handlers: Handlers<unknown> = {}) {
    return useSourceWrite(kbId, (source: NewSource) => createKbSource(kbId, source), handlers);
}

export function useRefreshKbSource(kbId: string, handlers: Handlers<void> = {}) {
    return useSourceWrite(kbId, (sid: string) => refreshKbSource(kbId, sid), handlers);
}

export function useUpdateKbSource(kbId: string, handlers: Handlers<void> = {}) {
    return useSourceWrite(
        kbId,
        ({ sid, patch }: { sid: string; patch: { name?: string; refresh?: RefreshRule } }) => updateKbSource(kbId, sid, patch),
        handlers,
    );
}

export function useDeleteKbSource(kbId: string, handlers: Handlers<void> = {}) {
    return useSourceWrite(kbId, (sid: string) => deleteKbSource(kbId, sid), handlers);
}

export function useIngestSitemap(kbId: string, handlers: Handlers<SitemapResult> = {}) {
    return useSourceWrite(kbId, ({ url, maxPages }: { url: string; maxPages: number }) => ingestKbSitemap(kbId, url, maxPages), handlers);
}

export function useIngestWorkflow(kbId: string, handlers: Handlers<number> = {}) {
    return useSourceWrite(
        kbId,
        ({ workflowId, mode }: { workflowId: string; mode: 'data' | 'definition' }) => ingestKbWorkflow(kbId, workflowId, mode),
        handlers,
    );
}
