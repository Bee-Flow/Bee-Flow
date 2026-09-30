/** Run-log queries and the live feed. Screens call these rather than useQuery. */

import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

import { useRunStream } from '@/features/automations';

import { getRunFacets, listRuns } from '../api/endpoints';
import { runLogKeys } from '../api/keys';
import { RANGE_HOURS, runQuery, type RunFilters } from '../model/filters';
import { applyRunEvent, type LiveRunEvent } from '../model/liveRows';
import type { RunPage, RunScope } from '../model/types';

/** The log, a page at a time, newest first (keyset cursor from the server). */
export function useRunLog(scope: RunScope, filters: RunFilters) {
    return useInfiniteQuery({
        queryKey: runLogKeys.list(scope, filters),
        queryFn: ({ pageParam, signal }) => listRuns(scope, runQuery(filters, pageParam), signal),
        initialPageParam: null as string | null,
        getNextPageParam: (last: RunPage) => last.nextCursor ?? undefined,
        // A new filter keeps the rows on screen while its own read is on the
        // way, so the chip just tapped is not swept away by a skeleton. A new
        // scope does not: "my runs" standing in for the organisation's would
        // show the wrong people's runs. (queryKey[2] is runLogKeys.list's scope.)
        placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === scope ? previous : undefined),
        // A refusal of the org scope is an answer, not a blip: asking again
        // cannot turn a 403 into a list.
        retry: false,
    });
}

/** One facets read over the list's window, narrowed to one routine or not. */
function facetsQuery(scope: RunScope, filters: RunFilters, automationId: string | null) {
    const range = RANGE_HOURS[filters.range] || 720;
    const mode = filters.mode === 'both' ? '' : filters.mode;
    return {
        queryKey: runLogKeys.facets(scope, range, mode, automationId),
        queryFn: ({ signal }: { signal: AbortSignal }) => getRunFacets(
            scope,
            { range, ...(mode ? { mode } : {}), ...(automationId ? { automationId } : {}) },
            signal,
        ),
        retry: false,
    };
}

/**
 * The chips' counts over the list's own window and its routine, as the
 * server scopes them (the web's useExecutions sends the same automationId).
 * "All" asks for 720 hours — the server's cap — and the bar says so.
 */
export function useRunFacets(scope: RunScope, filters: RunFilters) {
    return useQuery(facetsQuery(scope, filters, filters.automationId));
}

/**
 * The routine picker's choices: the same window NOT narrowed by routine, so
 * picking one still lists the others. With no routine picked it is the very
 * same query as useRunFacets, and one request serves both.
 */
export function useRunRoutines(scope: RunScope, filters: RunFilters) {
    return useQuery(facetsQuery(scope, filters, null));
}

/**
 * The "Now running" strip's read: a FIXED 24-hour window of live runs, apart
 * from the chips, because its heading says "last 24 hours".
 */
export function useNowRunning(scope: RunScope) {
    return useQuery({
        queryKey: runLogKeys.facets(scope, 24, 'live'),
        queryFn: ({ signal }) => getRunFacets(scope, { range: 24, mode: 'live' }, signal),
        retry: false,
    });
}

/**
 * Live updates for "my runs". The stream only carries the viewer's own
 * events, so the organisation list would tick for their rows and freeze for
 * everyone else's — the screen says it is not live instead. Each frame is
 * merged into the first page; a run that settles also re-reads the facets.
 */
export function useRunLogLive(scope: RunScope, filters: RunFilters): { connected: boolean } {
    const queryClient = useQueryClient();
    const { connected } = useRunStream({
        enabled: scope === 'mine',
        onEvent: (event: LiveRunEvent) => {
            queryClient.setQueryData<InfiniteData<RunPage, string | null>>(runLogKeys.list(scope, filters), (data) => {
                const first = data?.pages[0];
                if (!data || !first) return data;
                const runs = applyRunEvent(first.runs, event, filters);
                if (runs === first.runs) return data;
                return { ...data, pages: [{ ...first, runs: [...runs] }, ...data.pages.slice(1)] };
            });
            if (event.type === 'run.finished' || event.type === 'run.failed') {
                void queryClient.invalidateQueries({ queryKey: [...runLogKeys.all, 'facets'] });
            }
        },
    });
    return { connected };
}
