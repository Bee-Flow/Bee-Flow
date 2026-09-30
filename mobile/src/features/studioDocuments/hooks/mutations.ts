/**
 * Studio Documents writes other than editing an open document (that is
 * useDocumentWriter). Each refreshes what it changed; screens pass their own
 * feedback as handlers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    createStudioDocument,
    deleteStudioDocument,
    duplicateStudioDocument,
    restoreVersion,
    shareStudioDocument,
    validateStudioDocument,
    type ExportFormat,
} from '../api/endpoints';
import { studioDocumentKeys } from '../api/keys';
import type { CreateRequest } from '../model/create';
import type { DocKind, StudioDocument, ValidationResult } from '../model/types';

interface Handlers<D> {
    onSuccess?: (data: D) => void;
    onError?: (error: Error) => void;
}

function useRefreshList() {
    const queryClient = useQueryClient();
    return () => void queryClient.invalidateQueries({ queryKey: [...studioDocumentKeys.all, 'list'] });
}

export function useCreateStudioDocument(handlers: Handlers<StudioDocument | null> = {}) {
    const refreshList = useRefreshList();
    return useMutation({
        mutationFn: (input: CreateRequest) => createStudioDocument(input),
        onSuccess: (doc) => {
            refreshList();
            handlers.onSuccess?.(doc);
        },
        onError: handlers.onError,
    });
}

export function useDuplicateStudioDocument(handlers: Handlers<StudioDocument | null> = {}) {
    const refreshList = useRefreshList();
    return useMutation({
        mutationFn: ({ id, kind }: { id: string; kind?: DocKind }) => duplicateStudioDocument(id, kind),
        onSuccess: (doc) => {
            refreshList();
            handlers.onSuccess?.(doc);
        },
        onError: handlers.onError,
    });
}

export function useDeleteStudioDocument(handlers: Handlers<string> = {}) {
    const queryClient = useQueryClient();
    const refreshList = useRefreshList();
    return useMutation({
        mutationFn: async (id: string) => {
            await deleteStudioDocument(id);
            return id;
        },
        onSuccess: (id) => {
            queryClient.removeQueries({ queryKey: studioDocumentKeys.detail(id) });
            refreshList();
            handlers.onSuccess?.(id);
        },
        onError: handlers.onError,
    });
}

/**
 * Restore a revision. The answer carries no contract, so the document is
 * read again rather than patched from it.
 */
export function useRestoreVersion(id: string, handlers: Handlers<void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (versionId: string) => {
            const current = queryClient.getQueryData<StudioDocument | null>(studioDocumentKeys.detail(id));
            await restoreVersion(id, versionId, current?.versionId ?? null);
            await queryClient.refetchQueries({ queryKey: studioDocumentKeys.detail(id) });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: studioDocumentKeys.versions(id) });
            void queryClient.invalidateQueries({ queryKey: [...studioDocumentKeys.all, 'list'] });
            handlers.onSuccess?.();
        },
        onError: handlers.onError,
    });
}

export function useValidateStudioDocument(id: string) {
    return useMutation<ValidationResult, Error, { values: Record<string, unknown>; overrides: Record<string, unknown> }>({
        mutationFn: ({ values, overrides }) => validateStudioDocument(id, values, overrides),
    });
}

/** Download a rendering to the cache and hand it to the share sheet. */
export function useShareStudioDocument(id: string, handlers: Handlers<string> = {}) {
    return useMutation({
        mutationFn: ({ name, format }: { name: string; format: ExportFormat }) => shareStudioDocument(id, name, format),
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}
