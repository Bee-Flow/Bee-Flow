/**
 * The editor's writes: the autosave's CAS save, the pre-flight check,
 * publishing, version restore and public pages.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { Handlers } from './appMutations';
import { checkApp, restoreVersion, saveDefinition } from '../api/endpointsDefinition';
import { createPublicPage, deletePublicPage, publishApp } from '../api/endpointsPublish';
import { studioKeys } from '../api/keys';
import type { AppDefinition } from '../core/types';
import type { CheckInput, CheckResult, SaveDefinitionResult, StudioAppDetail } from '../model/apiTypes';
import type { CreatedPublicPage, PublishInput, PublishResult } from '../model/runtimeTypes';

export interface SaveDefinitionInput {
    definition: AppDefinition;
    baseVersion: number;
}

/**
 * The autosave's mutation. Resolves with a SaveDefinitionResult — a conflict
 * or an invalid draft is an outcome for the autosave to handle, not an error.
 * On a save the cached row moves to the new version (so a remount starts from
 * what the server holds) and the draft preview is re-read.
 */
export function useSaveDefinition(
    id: string,
    handlers: Handlers<SaveDefinitionResult, SaveDefinitionInput> = {},
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ definition, baseVersion }: SaveDefinitionInput) => saveDefinition(id, definition, baseVersion),
        onSuccess: (result, input) => {
            if (result.outcome === 'saved') {
                queryClient.setQueryData<StudioAppDetail | null>(studioKeys.row(id), (prev) =>
                    prev
                        ? {
                              ...prev,
                              app: { ...prev.app, definition: input.definition, definitionVersion: result.version },
                          }
                        : prev,
                );
                void queryClient.invalidateQueries({ queryKey: studioKeys.runtime(id, true) });
            }
            handlers.onSuccess?.(result, input);
        },
        onError: handlers.onError,
    });
}

/** Run the read-only pre-flight on the saved draft. */
export function useCheckApp(id: string, handlers: Handlers<CheckResult, CheckInput> = {}) {
    return useMutation({
        mutationKey: studioKeys.check(id),
        mutationFn: (input: CheckInput = {}) => checkApp(id, input),
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

/** Publish or unpublish. `outcome: 'invalid'` carries the issues to fix. */
export function usePublishApp(id: string, handlers: Handlers<PublishResult, PublishInput> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (input: PublishInput) => publishApp(id, input),
        onSuccess: (result, input) => {
            if (result.outcome === 'published') {
                void queryClient.invalidateQueries({ queryKey: studioKeys.app(id) });
                void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            }
            handlers.onSuccess?.(result, input);
        },
        onError: handlers.onError,
    });
}

/** Put a snapshot back as the draft; everything cached about the app is re-read. */
export function useRestoreVersion(id: string, handlers: Handlers<{ version: number | null }, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (versionId: string) => restoreVersion(id, versionId),
        onSuccess: (result, versionId) => {
            void queryClient.invalidateQueries({ queryKey: studioKeys.app(id) });
            void queryClient.invalidateQueries({ queryKey: studioKeys.lists });
            handlers.onSuccess?.(result, versionId);
        },
        onError: handlers.onError,
    });
}

export function useCreatePublicPage(id: string, handlers: Handlers<CreatedPublicPage, void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => createPublicPage(id),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: studioKeys.publicPages(id) });
            handlers.onSuccess?.(result, undefined);
        },
        onError: handlers.onError,
    });
}

export function useDeletePublicPage(id: string, handlers: Handlers<void, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (token: string) => deletePublicPage(id, token),
        onSuccess: (_result, token) => {
            void queryClient.invalidateQueries({ queryKey: studioKeys.publicPages(id) });
            handlers.onSuccess?.(undefined, token);
        },
        onError: handlers.onError,
    });
}
