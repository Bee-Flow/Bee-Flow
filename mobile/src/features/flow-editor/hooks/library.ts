/**
 * The writes that make or move automations rather than edit one: install a
 * template, import a file, export one, and the sidebar folders.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { automationKeys, type MutationHandlers } from '@/features/automations';

import { adoptRow } from './cacheSync';
import { createFolder, deleteFolder, updateFolder } from '../api/folders';
import { flowKeys } from '../api/keys';
import { createFromTemplate, exportFlow, importFlow } from '../api/templates';
import type { FlowExport, FlowFolder, FolderBody, SaveResult } from '../api/types';
import { ensureDraftSaved } from '../state/ensureSaved';

function useListRefresh() {
    const queryClient = useQueryClient();
    return (row: SaveResult['automation']) => {
        adoptRow(queryClient, row);
        void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
    };
}

/** Install a template as a new draft automation. `null` data: the template is gone. */
export function useCreateFromTemplate(handlers: MutationHandlers<SaveResult | null, string> = {}) {
    const refresh = useListRefresh();
    return useMutation({
        mutationFn: (templateId: string) => createFromTemplate(templateId),
        onSuccess: (result, templateId) => {
            if (result) refresh(result.automation);
            handlers.onSuccess?.(result, templateId);
        },
        onError: handlers.onError,
    });
}

/** Import an exported envelope as a new inactive draft; its warnings say what to reconnect. */
export function useImportFlow(handlers: MutationHandlers<SaveResult, Record<string, unknown>> = {}) {
    const refresh = useListRefresh();
    return useMutation({
        mutationFn: (envelope: Record<string, unknown>) => importFlow(envelope),
        onSuccess: (result, envelope) => {
            refresh(result.automation);
            handlers.onSuccess?.(result, envelope);
        },
        onError: handlers.onError,
    });
}

/** The portable envelope of this automation, saved first so the file has what is on screen. */
export function useExportFlow(flowKey: string, handlers: MutationHandlers<FlowExport> = {}) {
    return useMutation({
        mutationFn: async () => exportFlow(await ensureDraftSaved(flowKey)),
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

// ── Folders ──────────────────────────────────────────────────────────

function useFolderRefresh() {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: flowKeys.folders });
        void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
    };
}

export function useCreateFolder(handlers: MutationHandlers<FlowFolder | null, FolderBody> = {}) {
    const refresh = useFolderRefresh();
    return useMutation({
        mutationFn: (body: FolderBody) => createFolder(body),
        onSuccess: (folder, body) => {
            refresh();
            handlers.onSuccess?.(folder, body);
        },
        onError: handlers.onError,
    });
}

export function useUpdateFolder(handlers: MutationHandlers<FlowFolder | null, { folderId: string; patch: Partial<FolderBody> }> = {}) {
    const refresh = useFolderRefresh();
    return useMutation({
        mutationFn: ({ folderId, patch }: { folderId: string; patch: Partial<FolderBody> }) => updateFolder(folderId, patch),
        onSuccess: (folder, vars) => {
            refresh();
            handlers.onSuccess?.(folder, vars);
        },
        onError: handlers.onError,
    });
}

/** Delete a folder; its automations move back to the top level (the count is the data). */
export function useDeleteFolder(handlers: MutationHandlers<number, string> = {}) {
    const refresh = useFolderRefresh();
    return useMutation({
        mutationFn: (folderId: string) => deleteFolder(folderId),
        onSuccess: (detached, folderId) => {
            refresh();
            handlers.onSuccess?.(detached, folderId);
        },
        onError: handlers.onError,
    });
}
