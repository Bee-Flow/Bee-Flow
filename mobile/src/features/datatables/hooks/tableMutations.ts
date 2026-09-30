/**
 * Writes to a table itself: create, rename, its retention window, delete, its
 * columns, and the AI draft. Each owns its invalidation; a screen passes per-call feedback through
 * `mutate(vars, { onSuccess, onError })`.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
    createDatatable,
    deleteDatatable,
    draftDatatable,
    saveSchema,
    updateDatatable,
    type CreateBody,
} from '../api/endpoints';
import { datatableKeys } from '../api/keys';
import type { ColumnDraft, TablePatch } from '../model/types';

/** The table's own facts moved: its detail and the list row that carries them. */
export function refreshTable(queryClient: QueryClient, id: string): void {
    void queryClient.invalidateQueries({ queryKey: datatableKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: datatableKeys.list() });
}

export function useCreateDatatable() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateBody) => createDatatable(body),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: datatableKeys.list() }),
    });
}

export function useUpdateDatatable(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: TablePatch) => updateDatatable(id, patch),
        onSuccess: (table) => {
            if (table) queryClient.setQueryData(datatableKeys.detail(id), table);
            refreshTable(queryClient, id);
        },
    });
}

/** `confirmBreaking` only once the 409 `in_use` answer has been shown. */
export function useDeleteDatatable(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (confirmBreaking: boolean) => deleteDatatable(id, confirmBreaking),
        // The table's own queries are left to expire with the screen that leaves:
        // removing them under a mounted observer would refetch a 404.
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: datatableKeys.list() }),
    });
}

export interface SchemaSave {
    fields: ColumnDraft[];
    expectedVersion: number;
    confirmBreaking?: boolean;
}

/** A column change rewrites the physical table, so the rows are read again too. */
export function useSaveColumns(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ fields, expectedVersion, confirmBreaking }: SchemaSave) =>
            saveSchema(id, fields, expectedVersion, confirmBreaking),
        onSuccess: (schema) => {
            queryClient.setQueryData(datatableKeys.schema(id), schema);
            void queryClient.invalidateQueries({ queryKey: datatableKeys.rowsRoot(id) });
            void queryClient.invalidateQueries({ queryKey: datatableKeys.usage(id) });
        },
        // A version conflict means somebody else's list is the truth now.
        onError: () => void queryClient.invalidateQueries({ queryKey: datatableKeys.schema(id) }),
    });
}

export function useDraftDatatable() {
    return useMutation({ mutationFn: (brief: string) => draftDatatable(brief) });
}
