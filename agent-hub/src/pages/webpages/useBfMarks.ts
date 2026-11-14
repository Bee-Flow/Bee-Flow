import { useCallback } from 'react';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../api/webpagesApi';
import type { StripMark } from './WebpageCodeStrip';
import { messageOf } from '../../utils/caughtError';

/**
 * The bf-marks of one page, read from `GET /api/webpages/:id/bindings`.
 *
 * One read, two users: the IDE hands the result both to the Code-tab strip
 * (the legend, WebpageCodeStrip) and to Monaco (the decorations), so the
 * legend can never claim something other than what the editor draws.
 *
 * Four states, and they must stay distinct: loading, failed (`error`),
 * read-but-unreadable (`scanned:false` from the server) and read. The first
 * three all yield NO marks, and only the last one means "this page has none".
 */

interface BfMarksCounts {
    total: number;
    known: number;
    unknown: number;
}

interface BfMarksData {
    scanned?: boolean;
    marks?: StripMark[];
    counts?: BfMarksCounts;
    unknownTags?: string[];
    truncated?: number;
}

interface BfMarksState {
    loading: boolean;
    error: string | null;
    data: BfMarksData | null;
}

interface BfMarksOptions {
    /** Do not fetch while the Code tab is closed. */
    enabled?: boolean;
    /** Changes → fetch again (the IDE passes the time of the last save). */
    reloadKey?: unknown;
}

function marksState(query: UseQueryResult<BfMarksData | null>, active: boolean): BfMarksState {
    if (query.error) return { loading: active && query.isFetching, error: messageOf(query.error, 'failed'), data: null };
    return { loading: active && query.isFetching, error: null, data: query.data ?? null };
}

export function useBfMarks(webpageId: string | null | undefined, { enabled = true, reloadKey = null }: BfMarksOptions = {}) {
    const active = enabled && !!webpageId;
    const query = useQuery<BfMarksData | null>({
        queryKey: ['webpages', 'bfMarks', webpageId, reloadKey],
        enabled: active,
        staleTime: 0,
        retry: false,
        // A reload keeps the legend it showed until the new answer lands.
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const body = await api(`/${encodeURIComponent(webpageId as string)}/bindings`);
            return body && body.elements ? body.elements : null;
        },
    });
    const { refetch } = query;
    const load = useCallback(async () => { if (webpageId) await refetch(); }, [webpageId, refetch]);
    // Starts at `loading`, not at "nothing", whenever it will read: otherwise the
    // legend would show, for one frame, the warning that the marks could not be
    // worked out, before anyone has even looked. Not reading (the Code tab is
    // closed) is not loading, so the legend does not hang on "working it out".
    const state = marksState(query, active);

    const data = state.data;
    return {
        loading: state.loading,
        error: state.error,
        // `scanned:false` differs from a failed call, but to the reader it
        // amounts to the same thing: nothing was worked out. Both stay readable
        // apart (`error`), and `available` sums up whether there are marks to show.
        available: !!(data && data.scanned),
        marks: data && Array.isArray(data.marks) ? data.marks : [],
        counts: (data && data.counts) || { total: 0, known: 0, unknown: 0 },
        unknownTags: (data && data.unknownTags) || [],
        truncated: (data && data.truncated) || 0,
        reload: load,
    };
}
