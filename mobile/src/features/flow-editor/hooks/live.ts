/**
 * The pending count of the open routine: how many structural versions the
 * working copy is ahead of the live one (handoff 5).
 *
 * The row carries it when it comes from a read (GET /:id) or a publish, but
 * not from a save: the server leaves it out of a PUT answer rather than
 * guess. GET /:id/counts fills that gap, read again whenever the row's
 * version or live state moves, as the web header does. Every row that does
 * carry the figure is written into the same cache entry first, so an
 * autosave never blinks the count away while the new one is on its way.
 *
 * Nothing is read from a server without the live split (no `liveVersion` on
 * the row) or for a routine that never went live.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getAutomationCounts } from '@/features/automations';

import { flowKeys } from '../api/keys';
import type { FlowAutomation } from '../api/types';

type LiveFields = Pick<FlowAutomation, 'id' | 'version' | 'isActive' | 'updatedAt' | 'liveVersion' | 'pendingChanges'>;

/** What changes when the count can have moved (the web header's stamp). */
function stampOf(row: LiveFields | null): string {
    if (!row) return '';
    return `${row.version}:${row.liveVersion ?? ''}:${row.isActive ? 1 : 0}:${row.updatedAt ?? ''}`;
}

/** GET /:id/counts' figure for the row; null while there is none (the row's own figure then wins anyway). */
export function usePendingCount(row: LiveFields | null): number | null {
    const queryClient = useQueryClient();
    const id = row?.id ?? '';
    const rowPending = row?.pendingChanges;
    const needsCount = !!id && rowPending === undefined && row?.liveVersion != null;
    const stamp = stampOf(row);

    useEffect(() => {
        if (id && typeof rowPending === 'number') queryClient.setQueryData(flowKeys.counts(id), rowPending);
    }, [queryClient, id, rowPending]);

    useEffect(() => {
        if (needsCount) void queryClient.invalidateQueries({ queryKey: flowKeys.counts(id) });
    }, [queryClient, id, needsCount, stamp]);

    const counts = useQuery({
        queryKey: flowKeys.counts(id),
        queryFn: async ({ signal }) => (await getAutomationCounts(id, signal)).pendingChanges,
        enabled: needsCount,
        // Fresh until the row moves: the effect above says when.
        staleTime: Infinity,
    });
    return counts.data ?? null;
}
