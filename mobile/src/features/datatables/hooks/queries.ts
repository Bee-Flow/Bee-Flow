/** Datatable queries. Screens call these rather than useQuery. */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getDatatable, getDirectory, getSchema, listDatatables, listGrants, listUsage } from '../api/endpoints';
import { datatableKeys } from '../api/keys';
import { countExpiringRows, listRows } from '../api/rows';
import { EXPIRING_WITHIN_DAYS, expiringSoonCutoffIso } from '../model/retention';
import type { Datatable, RowQuery } from '../model/types';

export function useDatatables() {
    return useQuery({ queryKey: datatableKeys.list(), queryFn: ({ signal }) => listDatatables(signal) });
}

export function useDatatable(id: string) {
    return useQuery({
        queryKey: datatableKeys.detail(id),
        queryFn: ({ signal }) => getDatatable(id, signal),
        enabled: id !== '',
    });
}

export function useDatatableSchema(id: string) {
    return useQuery({
        queryKey: datatableKeys.schema(id),
        queryFn: ({ signal }) => getSchema(id, signal),
        enabled: id !== '',
    });
}

/**
 * The rows, a keyset page at a time. The next page is asked for with the
 * cursor the last one returned, so the list grows as it is scrolled and never
 * holds more than the pages actually looked at.
 */
export function useDatatableRows(id: string, query: RowQuery) {
    return useInfiniteQuery({
        queryKey: datatableKeys.rows(id, query),
        queryFn: ({ signal, pageParam }) => listRows(id, query, pageParam, signal),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
        enabled: id !== '',
    });
}

/**
 * How many rows the retention sweep takes in the next week — asked only while
 * a window and its column are set. The cutoff is worked out when the count is
 * fetched, so a refetch moves it along with the clock.
 */
export function useExpiringRows(table: Pick<Datatable, 'id' | 'retentionDays' | 'retentionField'>) {
    const days = table.retentionDays ?? 0;
    const field = table.retentionField ?? '';
    return useQuery({
        queryKey: datatableKeys.expiring(table.id, days, field),
        queryFn: ({ signal }) => countExpiringRows(table.id, field, expiringSoonCutoffIso(days, EXPIRING_WITHIN_DAYS) ?? '', signal),
        enabled: table.id !== '' && days > 0 && field !== '',
    });
}

export function useDatatableGrants(id: string, enabled = true) {
    return useQuery({
        queryKey: datatableKeys.grants(id),
        queryFn: ({ signal }) => listGrants(id, signal),
        enabled: enabled && id !== '',
    });
}

/** Who uses this table: the Used-by tab, and the answer the delete sheet shows. */
export function useDatatableUsage(id: string) {
    return useQuery({
        queryKey: datatableKeys.usage(id),
        queryFn: ({ signal }) => listUsage(id, signal),
        enabled: id !== '',
    });
}

/** Best-effort names; never an error (see getDirectory). */
export function useOrgDirectory(enabled: boolean) {
    return useQuery({
        queryKey: datatableKeys.directory(),
        queryFn: ({ signal }) => getDirectory(signal),
        enabled,
        staleTime: 60_000,
    });
}
