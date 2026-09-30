/**
 * App Studio writes on the app itself: create, import, rename, delete and the
 * template upgrade. Each owns its invalidation; the screen passes its own
 * feedback (close a sheet, navigate) as handlers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createApp, deleteApp, importApp, updateApp, upgradeTemplate } from '../api/endpointsApps';
import { studioKeys } from '../api/keys';
import type {
    CreateAppInput,
    CreateAppResult,
    ImportAppResult,
    StudioAppDetail,
    StudioAppRow,
    TemplateUpgradeResult,
    UpdateAppInput,
} from '../model/apiTypes';

export interface Handlers<D, V> {
    onSuccess?: (data: D, vars: V) => void;
    onError?: (error: Error, vars: V) => void;
}

export function useCreateApp(handlers: Handlers<CreateAppResult, CreateAppInput> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateAppInput) => createApp(input),
        onSuccess: (result, input) => {
            void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            handlers.onSuccess?.(result, input);
        },
        onError: handlers.onError,
    });
}

export interface ImportAppInput {
    /** The parsed archive file. */
    envelope: unknown;
    name?: string;
}

export function useImportApp(handlers: Handlers<ImportAppResult, ImportAppInput> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ envelope, name }: ImportAppInput) => importApp(envelope, name),
        onSuccess: (result, input) => {
            void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            handlers.onSuccess?.(result, input);
        },
        onError: handlers.onError,
    });
}

/** Rename or change the metadata (icon, colour, category) of one app. */
export function useRenameApp(id: string, handlers: Handlers<StudioAppRow, UpdateAppInput> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (input: UpdateAppInput) => updateApp(id, input),
        onSuccess: (row, input) => {
            // The row cache holds the editor's draft; keep it and swap the meta.
            queryClient.setQueryData<StudioAppDetail | null>(studioKeys.row(id), (prev) =>
                prev ? { ...prev, app: { ...prev.app, ...row } } : prev,
            );
            void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            handlers.onSuccess?.(row, input);
        },
        onError: handlers.onError,
    });
}

export function useDeleteApp(handlers: Handlers<void, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteApp(id),
        onSuccess: (_result, id) => {
            queryClient.removeQueries({ queryKey: studioKeys.app(id) });
            void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            handlers.onSuccess?.(undefined, id);
        },
        onError: handlers.onError,
    });
}

export function useUpgradeTemplate(id: string, handlers: Handlers<TemplateUpgradeResult, void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => upgradeTemplate(id),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: studioKeys.app(id) });
            void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            handlers.onSuccess?.(result, undefined);
        },
        onError: handlers.onError,
    });
}
