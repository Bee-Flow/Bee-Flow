/**
 * An app's data behind hooks: tables, paged records, record writes, and the
 * owner's schema, datasets and members. Every write invalidates the app's
 * data keys — a record list is RLS-scoped and server-sorted, so patching it
 * locally would guess at what the viewer may see.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Handlers } from './appMutations';
import { createRecord, deleteRecord, getRecord, listRecords, listTables, updateRecord } from '../api/endpointsData';
import { getSchema, listDatasets, listMembers, saveSchema } from '../api/endpointsSchema';
import { studioKeys } from '../api/keys';
import type { OpenRecord } from '../model/apiTypes';
import type {
    DataRecord,
    RecordsQuery,
    RecordUpdateResult,
    RecordWrite,
    SaveSchemaResult,
} from '../model/runtimeTypes';

interface Enabled {
    enabled?: boolean;
}

export function useDataTables(appId: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.tables(appId),
        queryFn: ({ signal }) => listTables(appId, signal),
        enabled: enabled && Boolean(appId),
    });
}

/** Keyset-paged records: `fetchNextPage()` while `hasNextPage`. */
export function useTableRecords(appId: string, tableId: string, query: Omit<RecordsQuery, 'cursor'> = {}) {
    return useInfiniteQuery({
        queryKey: studioKeys.records(appId, tableId, query),
        queryFn: ({ pageParam, signal }) => listRecords(appId, tableId, { ...query, cursor: pageParam ?? undefined }, signal),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
        enabled: Boolean(appId && tableId),
    });
}

export function useRecord(appId: string, tableId: string, recordId: string | null) {
    return useQuery({
        queryKey: studioKeys.record(appId, tableId, recordId ?? ''),
        queryFn: ({ signal }) => getRecord(appId, tableId, recordId as string, signal),
        enabled: Boolean(appId && tableId && recordId),
    });
}

function useInvalidateData(appId: string) {
    const queryClient = useQueryClient();
    return () => void queryClient.invalidateQueries({ queryKey: studioKeys.data(appId) });
}

export function useCreateRecord(appId: string, tableId: string, handlers: Handlers<RecordWrite, DataRecord> = {}) {
    const invalidate = useInvalidateData(appId);
    return useMutation({
        mutationFn: (values: DataRecord) => createRecord(appId, tableId, values),
        onSuccess: (result, values) => {
            invalidate();
            handlers.onSuccess?.(result, values);
        },
        onError: handlers.onError,
    });
}

export interface RecordChange {
    recordId: string;
    values: DataRecord;
    /** The row's `updated_at` as loaded; makes the write conditional. */
    expectedUpdatedAt?: string;
}

/** `outcome: 'conflict'` carries the row as it now stands. */
export function useUpdateRecord(
    appId: string,
    tableId: string,
    handlers: Handlers<RecordUpdateResult, RecordChange> = {},
) {
    const invalidate = useInvalidateData(appId);
    return useMutation({
        mutationFn: ({ recordId, ...change }: RecordChange) => updateRecord(appId, tableId, recordId, change),
        onSuccess: (result, change) => {
            invalidate();
            handlers.onSuccess?.(result, change);
        },
        onError: handlers.onError,
    });
}

export function useDeleteRecord(appId: string, tableId: string, handlers: Handlers<void, string> = {}) {
    const invalidate = useInvalidateData(appId);
    return useMutation({
        mutationFn: (recordId: string) => deleteRecord(appId, tableId, recordId),
        onSuccess: (_result, recordId) => {
            invalidate();
            handlers.onSuccess?.(undefined, recordId);
        },
        onError: handlers.onError,
    });
}

/** The owner's data model. `staleTime: 0`: the AI builder moves it too. */
export function useAppSchema(appId: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.schema(appId),
        queryFn: ({ signal }) => getSchema(appId, signal),
        enabled: enabled && Boolean(appId),
        staleTime: 0,
    });
}

export interface SaveSchemaInput {
    model: OpenRecord;
    expectedVersion: number | null;
}

/** CAS save of the model; conflict/invalid come back as outcomes. */
export function useSaveSchema(appId: string, handlers: Handlers<SaveSchemaResult, SaveSchemaInput> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ model, expectedVersion }: SaveSchemaInput) => saveSchema(appId, model, expectedVersion),
        onSuccess: (result, input) => {
            if (result.outcome === 'saved') {
                queryClient.setQueryData(studioKeys.schema(appId), { model: input.model, modelVersion: result.version });
                void queryClient.invalidateQueries({ queryKey: studioKeys.data(appId) });
            }
            handlers.onSuccess?.(result, input);
        },
        onError: handlers.onError,
    });
}

export function useAppDatasets(appId: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.datasets(appId),
        queryFn: ({ signal }) => listDatasets(appId, signal),
        enabled: enabled && Boolean(appId),
    });
}

export function useAppMembers(appId: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.members(appId),
        queryFn: ({ signal }) => listMembers(appId, signal),
        enabled: enabled && Boolean(appId),
    });
}
