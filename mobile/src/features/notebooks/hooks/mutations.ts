/**
 * Notebook writes. Each hook owns its invalidation; the screen passes what
 * should happen on its side (close a sheet, toast) as handlers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useIngestFlow, type IngestFlow } from '@/features/knowledge';
import { useToast } from '@/shared/ui';

import {
    addTextSource,
    addUrlSource,
    cancelSource,
    createNotebook,
    deleteNotebook,
    deleteSource,
    notebookSourceTarget,
    renameSource,
    retrySource,
    updateNotebook,
} from '../api/endpoints';
import { notebookKeys } from '../api/keys';
import type { Notebook } from '../model/types';

interface Handlers<D, V> {
    onSuccess?: (data: D, vars: V) => void;
}

/** A write that failed says why, in the server's words where it gave some. */
function useErrorToast(): (err: unknown) => void {
    const { toast } = useToast();
    return useCallback((err: unknown) => toast(describeError(err).message, 'error'), [toast]);
}

/** Re-read one notebook and its sources. */
export function useRefreshNotebook(id: string): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: notebookKeys.detail(id) });
    }, [queryClient, id]);
}

/** Re-read the stored transcript once a turn has settled. */
export function useRefreshConversation(id: string): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: notebookKeys.conversation(id) });
    }, [queryClient, id]);
}

export function useCreateNotebook(handlers: Handlers<Notebook | null, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (name: string) => createNotebook({ name }),
        onSuccess: (notebook, name) => {
            void queryClient.invalidateQueries({ queryKey: notebookKeys.all });
            handlers.onSuccess?.(notebook, name);
        },
    });
}

export function useDeleteNotebook(handlers: Handlers<void, string> = {}) {
    const queryClient = useQueryClient();
    const onError = useErrorToast();
    return useMutation({
        mutationFn: (id: string) => deleteNotebook(id),
        onSuccess: (_result, id) => {
            handlers.onSuccess?.(undefined, id);
            void queryClient.invalidateQueries({ queryKey: notebookKeys.all });
        },
        onError,
    });
}

/** Rename a notebook. The name shows in the detail header and every list. */
export function useRenameNotebook(id: string, handlers: Handlers<void, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (name: string) => updateNotebook(id, { name }),
        onSuccess: (_result, name) => {
            handlers.onSuccess?.(undefined, name);
            void queryClient.invalidateQueries({ queryKey: notebookKeys.detail(id) });
            void queryClient.invalidateQueries({ queryKey: notebookKeys.all });
        },
    });
}

/** Rename one source (PATCH …/sources/:sid), as the web's inline rename does. */
export function useRenameSource(id: string, handlers: Handlers<string, { sourceId: string; name: string }> = {}) {
    const refresh = useRefreshNotebook(id);
    return useMutation({
        mutationFn: (input: { sourceId: string; name: string }) => renameSource(id, input.sourceId, input.name),
        onSuccess: (name, input) => {
            handlers.onSuccess?.(name, input);
            refresh();
        },
    });
}

/**
 * Pinning floats a notebook to the top of the list — the one piece of notebook
 * metadata worth changing from a phone.
 */
export function useSetNotebookPinned(id: string, handlers: Handlers<void, boolean> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (next: boolean) => updateNotebook(id, { pinned: next }),
        onSuccess: (_result, next) => {
            handlers.onSuccess?.(undefined, next);
            void queryClient.invalidateQueries({ queryKey: notebookKeys.all });
        },
        onError: useErrorToast(),
    });
}

/** Retry a failed source, or give up on one stuck in processing. */
export function useSourceAction(id: string, action: 'retry' | 'cancel') {
    const refresh = useRefreshNotebook(id);
    return useMutation({
        mutationFn: (sourceId: string) => (action === 'retry' ? retrySource(id, sourceId) : cancelSource(id, sourceId)),
        onSuccess: refresh,
        onError: useErrorToast(),
    });
}

export function useDeleteSource(id: string, handlers: Handlers<void, string> = {}) {
    const refresh = useRefreshNotebook(id);
    return useMutation({
        mutationFn: (sourceId: string) => deleteSource(id, sourceId),
        onSuccess: (_result, sourceId) => {
            handlers.onSuccess?.(undefined, sourceId);
            refresh();
        },
        onError: useErrorToast(),
    });
}

/**
 * Adding sources. The route answers with the source row before ingestion
 * starts, so a new row appears immediately and then polls to `ready`.
 *
 * The shared flow's link and text writes have no error handler of their own:
 * a rejected link (a 400 "URL required", a 403 plan gate, no network) used to
 * leave the sheet spinning down to nothing, with no word said. So each write
 * says its own failure here, and still rejects, which keeps the sheet open.
 */
export function useNotebookIngestFlow(id: string): IngestFlow {
    const t = useTranslation();
    const { toast } = useToast();
    const onError = useErrorToast();
    const refresh = useRefreshNotebook(id);
    const said = <T>(write: Promise<T>): Promise<T> =>
        write.catch((err: unknown) => {
            onError(err);
            throw err;
        });
    return useIngestFlow({
        target: notebookSourceTarget(id),
        addUrl: (url) => said(addUrlSource(id, url.trim())),
        addText: (text, name) => said(addTextSource(id, text.trim(), name.trim() || undefined)),
        onUrlAdded: () => toast(t('notebooks.source_added', 'Source added'), 'success'),
        onChanged: refresh,
    });
}
