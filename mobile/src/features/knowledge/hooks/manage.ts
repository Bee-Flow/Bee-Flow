/**
 * Managing a knowledge base: its settings, audience, copies, re-index, usage,
 * categories, favourites, the system bases and bulk document delete. Screens
 * call these rather than useQuery / useMutation.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useRefreshKnowledge } from './mutations';
import { knowledgeKeys } from '../api/keys';
import {
    bulkDeleteKbDocuments,
    duplicateKnowledgeBase,
    getKbUsage,
    listKbCategories,
    listKbFavorites,
    listSystemKnowledgeBases,
    publishKnowledgeBase,
    reindexKnowledgeBase,
    setKbFavorite,
    updateKnowledgeBase,
    type KbSettingsPatch,
} from '../api/manageEndpoints';
import type { ReindexResult } from '../model/settings';
import type { KnowledgeBase } from '../model/types';

interface Handlers<D> {
    onSuccess?: (data: D) => void;
    onError?: (error: Error) => void;
}

export function useKbUsage(kbId: string) {
    return useQuery({ queryKey: knowledgeKeys.usage(kbId), queryFn: ({ signal }) => getKbUsage(kbId, signal), enabled: Boolean(kbId) });
}

export function useKbCategories() {
    return useQuery({ queryKey: knowledgeKeys.categories, queryFn: ({ signal }) => listKbCategories(signal), staleTime: 5 * 60_000 });
}

export function useSystemKnowledgeBases(enabled = true) {
    return useQuery({ queryKey: knowledgeKeys.system, queryFn: ({ signal }) => listSystemKnowledgeBases(signal), enabled });
}

/** The favourite ids as a set. A failed read is simply "none starred", which only hides a filter. */
export function useKbFavorites() {
    return useQuery({
        queryKey: knowledgeKeys.favorites,
        queryFn: ({ signal }) => listKbFavorites(signal),
        select: (ids) => new Set(ids),
    });
}

/** Star or unstar, shown at once and rolled back if the server says no. */
export function useToggleKbFavorite() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => setKbFavorite(id, favorite),
        onMutate: ({ id, favorite }) => {
            const before = queryClient.getQueryData<string[]>(knowledgeKeys.favorites);
            const rest = (before ?? []).filter((x) => x !== id);
            queryClient.setQueryData(knowledgeKeys.favorites, favorite ? [...rest, id] : rest);
            return { before };
        },
        onError: (_e, _vars, context) => queryClient.setQueryData(knowledgeKeys.favorites, context?.before),
        onSettled: () => void queryClient.invalidateQueries({ queryKey: knowledgeKeys.favorites }),
    });
}

/** Settings and audience both re-read the base and the list it appears in. */
function useKbWrite<V, D>(write: (vars: V) => Promise<D>, handlers: Handlers<D>) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (data) => {
            void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
            handlers.onSuccess?.(data);
        },
        onError: handlers.onError,
    });
}

export function useUpdateKnowledgeBase(kbId: string, handlers: Handlers<void> = {}) {
    return useKbWrite((patch: KbSettingsPatch) => updateKnowledgeBase(kbId, patch), handlers);
}

type PublishBody = { isPublished: boolean; sharedGroups?: string[] };

/**
 * The audience, shown at once: the sheet computes the next toggle from the
 * cached base, and the server replaces `sharedGroups` wholesale, so a second
 * tick sent before the first one's re-read would otherwise drop the first.
 * Rolled back if the server says no; re-read once the last one settles.
 */
export function usePublishKnowledgeBase(kbId: string, handlers: Handlers<void> = {}) {
    const queryClient = useQueryClient();
    const key = knowledgeKeys.base(kbId);
    const mutationKey = [...key, 'publish'];
    return useMutation({
        mutationKey,
        mutationFn: (body: PublishBody) => publishKnowledgeBase(kbId, body),
        onMutate: async (body) => {
            await queryClient.cancelQueries({ queryKey: key, exact: true });
            const before = queryClient.getQueryData<KnowledgeBase | null>(key);
            queryClient.setQueryData<KnowledgeBase | null>(key, (old) =>
                old ? { ...old, is_published: body.isPublished, shared_groups: body.sharedGroups ?? [] } : old,
            );
            return { before };
        },
        onSuccess: () => handlers.onSuccess?.(),
        onError: (e, _body, context) => {
            if (context) queryClient.setQueryData(key, context.before);
            handlers.onError?.(e);
        },
        onSettled: () => {
            if (queryClient.isMutating({ mutationKey }) <= 1) void queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
        },
    });
}

export function useDuplicateKnowledgeBase(kbId: string, handlers: Handlers<KnowledgeBase | null> = {}) {
    return useKbWrite((withSources: boolean) => duplicateKnowledgeBase(kbId, withSources), handlers);
}

export function useReindexKnowledgeBase(kbId: string, handlers: Handlers<ReindexResult> = {}) {
    return useKbWrite(() => reindexKnowledgeBase(kbId), handlers);
}

/** Delete the selected documents; the result says which ids are still there. */
export function useBulkDeleteDocuments(kbId: string, handlers: Handlers<{ deleted: string[]; remaining: string[]; error: unknown }> = {}) {
    const refresh = useRefreshKnowledge();
    return useMutation({
        mutationFn: (ids: readonly string[]) => bulkDeleteKbDocuments(kbId, ids),
        onSuccess: (result) => {
            refresh();
            handlers.onSuccess?.(result);
        },
        onError: handlers.onError,
    });
}
