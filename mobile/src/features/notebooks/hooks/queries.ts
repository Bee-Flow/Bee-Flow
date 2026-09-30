/** Notebook queries. Screens call these rather than useQuery. */

import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
    getNotebook,
    getNotebookConversation,
    getSourceContent,
    listNotebooks,
    type NotebookFilter,
} from '../api/endpoints';
import { notebookKeys } from '../api/keys';
import { isWorking } from '../model/format';
import type { NotebookListResponse } from '../model/types';

/** How often to re-read while a source is still being ingested. */
const INGEST_POLL_MS = 4000;

/** The list screen's page: server-searched, server-filtered. */
export function useNotebooks(term: string, filter: NotebookFilter) {
    return useQuery({
        queryKey: notebookKeys.list(term, filter),
        queryFn: ({ signal }) => listNotebooks({ search: term, filter, sort: 'activity', limit: 60 }, signal),
    });
}

/** The Library hub's short page, most recently active first. */
export function useNotebookSearch(term: string) {
    return useQuery({
        queryKey: notebookKeys.search(term),
        queryFn: ({ signal }) => listNotebooks({ search: term, sort: 'activity', limit: 30 }, signal),
    });
}

/**
 * One notebook and its sources. Polls only while something is actually being
 * ingested: a notebook at rest must not keep a phone's radio awake.
 */
export function useNotebook(id: string) {
    return useQuery({
        queryKey: notebookKeys.detail(id),
        queryFn: ({ signal }) => getNotebook(id, signal),
        enabled: Boolean(id),
        refetchInterval: (q) => (q.state.data?.sources.some(isWorking) ? INGEST_POLL_MS : false),
    });
}

/**
 * The stored transcript. Only fetched once the chat half is opened: it is an
 * encrypted blob, and decrypting it for a screen nobody looked at is waste.
 */
export function useNotebookConversation(id: string, enabled: boolean) {
    return useQuery({
        queryKey: notebookKeys.conversation(id),
        queryFn: ({ signal }) => getNotebookConversation(id, signal),
        enabled: Boolean(id) && enabled,
    });
}

/** A source's extracted text, fetched while it is being previewed. */
export function useSourceContent(id: string, sourceId: string | null) {
    return useQuery({
        queryKey: notebookKeys.sourceContent(id, sourceId ?? ''),
        queryFn: ({ signal }) => getSourceContent(id, sourceId ?? '', signal),
        enabled: sourceId !== null,
    });
}

/**
 * `pinned` lives on the card projection, not on the notebook row the detail
 * route returns, so it is read back from whichever list cache the screen was
 * opened from — and false when that cache is cold. Not a subscription: the
 * caller keeps its own override after a toggle.
 */
export function useCachedPinned(id: string): boolean {
    const queryClient = useQueryClient();
    return Boolean(
        queryClient
            .getQueriesData<NotebookListResponse>({ queryKey: notebookKeys.all })
            .flatMap(([, data]) => data?.notebooks ?? [])
            .find((card) => card.id === id)?.pinned,
    );
}
