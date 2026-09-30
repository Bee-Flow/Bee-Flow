/**
 * Memory writes. Every one refreshes both views of the rows — the Memory
 * screen's pages and the Library sheet's page — because they show the same
 * table; the screen passes its own feedback (toast, closing a sheet) as
 * handlers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { bulkDeleteMemories, clearAllMemories, createMemory, deleteMemory } from '../api/endpoints';
import { memoryKeys } from '../api/keys';

interface Handlers<D> {
    onSuccess?: (data: D) => void;
    onError?: (error: Error) => void;
}

function useRefreshMemory(): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: memoryKeys.all });
        void queryClient.invalidateQueries({ queryKey: memoryKeys.sheetAll });
    }, [queryClient]);
}

export function useForgetMemory(handlers: Handlers<void> = {}) {
    const refresh = useRefreshMemory();
    return useMutation({
        mutationFn: (id: string) => deleteMemory(id),
        onSuccess: () => {
            handlers.onSuccess?.();
            refresh();
        },
        onError: handlers.onError,
    });
}

/** Resolves with how many rows actually went (see bulkDeleteMemories). */
export function useForgetMemories(handlers: Handlers<number> = {}) {
    const refresh = useRefreshMemory();
    return useMutation({
        mutationFn: (ids: string[]) => bulkDeleteMemories(ids),
        onSuccess: (deleted) => {
            handlers.onSuccess?.(deleted);
            refresh();
        },
        onError: handlers.onError,
    });
}

export function useForgetEverything(handlers: Handlers<void> = {}) {
    const refresh = useRefreshMemory();
    return useMutation({
        mutationFn: () => clearAllMemories(),
        onSuccess: () => {
            handlers.onSuccess?.();
            refresh();
        },
        onError: handlers.onError,
    });
}

/** A standing instruction, typed in by the person rather than inferred. */
export function useAddInstruction(handlers: Handlers<void> = {}) {
    const refresh = useRefreshMemory();
    return useMutation({
        mutationFn: (content: string) => createMemory(content, 'instruction'),
        onSuccess: () => {
            handlers.onSuccess?.();
            refresh();
        },
    });
}
