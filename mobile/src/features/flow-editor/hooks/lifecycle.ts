/**
 * The writes around the flow that are not the flow itself: arming it, making
 * its working copy live, its name and description, its folder, and going back
 * to a saved version.
 * `flowKey` is the routine id, or a new routine's draft key (FlowDraft.key).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { translate } from '@/core/i18n';
import { issueDetailsOf, type MutationHandlers } from '@/features/automations';

import { adoptRow, refreshRoutineViews } from './cacheSync';
import { isVersionChanged, publishFlow, saveFlow, setFlowActive } from '../api/definition';
import { moveToFolder } from '../api/folders';
import { flowKeys } from '../api/keys';
import type { RestoreResult, SaveResult } from '../api/types';
import { restoreVersion } from '../api/versions';
import { automationIdFor, ensureDraftSaved } from '../state/ensureSaved';
import { peekDraftStore } from '../state/registry';

/**
 * Arm or disarm the routine. Arming validates the STORED definition at the
 * strict stage, so the draft is saved first; its refusal's `details` and its
 * warnings become the store's activation findings (they stay until the next
 * attempt). The error is re-thrown for the screen to word.
 */
export function useActivateFlow(flowKey: string, handlers: MutationHandlers<SaveResult, boolean> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (active: boolean) => {
            const store = peekDraftStore(flowKey);
            const id = active ? await ensureDraftSaved(flowKey) : automationIdFor(flowKey);
            if (!id) throw new Error(translate('mobile.flow.not_created', 'This routine has not been saved yet.'));
            try {
                const result = await setFlowActive(id, active);
                store?.getState().setIssues('activate', active ? { errors: [], warnings: result.warnings } : null);
                return result;
            } catch (err) {
                const details = issueDetailsOf(err);
                if (details.length) store?.getState().setIssues('activate', { errors: details, warnings: [] });
                throw err;
            }
        },
        onSuccess: (result, active) => {
            adoptRow(queryClient, result.automation);
            refreshRoutineViews(queryClient, result.automation?.id ?? null);
            handlers.onSuccess?.(result, active);
        },
        onError: handlers.onError,
    });
}

/**
 * "Make vN live" (handoff 5): the working copy becomes the live version.
 * `version` is the one on screen, and nothing is saved first: the action
 * waits while a save is pending, so what goes live is what the person saw.
 * The checks are activation's, so a refusal's `details` and the warnings
 * land where activation's do. When the routine moved on since (409
 * `version_changed`) it is read again, so the screen shows what is there
 * now; the error is re-thrown for the screen to word.
 */
export function usePublishFlow(flowKey: string, handlers: MutationHandlers<SaveResult, number | null> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (version: number | null) => {
            const store = peekDraftStore(flowKey);
            const id = automationIdFor(flowKey);
            if (!id) throw new Error(translate('mobile.flow.not_created', 'This routine has not been saved yet.'));
            try {
                const result = await publishFlow(id, version);
                store?.getState().setIssues('activate', { errors: [], warnings: result.warnings });
                return result;
            } catch (err) {
                const details = issueDetailsOf(err);
                if (details.length) store?.getState().setIssues('activate', { errors: details, warnings: [] });
                if (isVersionChanged(err)) void queryClient.invalidateQueries({ queryKey: flowKeys.definition(id) });
                throw err;
            }
        },
        onSuccess: (result, version) => {
            adoptRow(queryClient, result.automation);
            refreshRoutineViews(queryClient, result.automation?.id ?? null);
            // Which version is live is a column of the version list.
            if (result.automation) void queryClient.invalidateQueries({ queryKey: flowKeys.versions(result.automation.id) });
            handlers.onSuccess?.(result, version);
        },
        onError: handlers.onError,
    });
}

/** Rename or re-describe. Never sends the definition — that is the draft store's. */
export function useUpdateFlowMeta(flowKey: string, handlers: MutationHandlers<SaveResult, { title?: string; description?: string | null }> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (patch: { title?: string; description?: string | null }) => saveFlow(await ensureDraftSaved(flowKey), patch),
        onSuccess: (result, patch) => {
            adoptRow(queryClient, result.automation);
            refreshRoutineViews(queryClient, result.automation?.id ?? null);
            handlers.onSuccess?.(result, patch);
        },
        onError: handlers.onError,
    });
}

/** File the routine in a folder, or `null` for the top level. */
export function useMoveToFolder(flowKey: string, handlers: MutationHandlers<SaveResult, string | null> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (folderId: string | null) => moveToFolder(await ensureDraftSaved(flowKey), folderId),
        onSuccess: (result, folderId) => {
            adoptRow(queryClient, result.automation);
            refreshRoutineViews(queryClient, result.automation?.id ?? null);
            void queryClient.invalidateQueries({ queryKey: flowKeys.folders });
            handlers.onSuccess?.(result, folderId);
        },
        onError: handlers.onError,
    });
}

/**
 * Go back to a saved version. The draft is saved first — so what is on screen
 * becomes a version of its own and the restore can be undone from the list —
 * and the restored definition then replaces the draft as ONE undo entry.
 */
export function useRestoreVersion(flowKey: string, handlers: MutationHandlers<RestoreResult, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (versionId: string) => {
            const id = await ensureDraftSaved(flowKey);
            const result = await restoreVersion(id, versionId);
            const row = result.automation;
            if (row) peekDraftStore(flowKey)?.getState().replaceDefinition(row.definition, { persisted: true, version: row.version });
            return result;
        },
        onSuccess: (result, versionId) => {
            adoptRow(queryClient, result.automation);
            if (result.automation) void queryClient.invalidateQueries({ queryKey: flowKeys.versions(result.automation.id) });
            handlers.onSuccess?.(result, versionId);
        },
        onError: handlers.onError,
    });
}
