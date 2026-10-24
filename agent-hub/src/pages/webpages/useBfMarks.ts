import { useCallback, useEffect, useState } from 'react';
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

export function useBfMarks(webpageId: string | null | undefined, { enabled = true, reloadKey = null }: BfMarksOptions = {}) {
    // Starts at `loading`, not at "nothing": between the first render and the
    // effect below the legend would otherwise show, for one frame, the warning
    // that the marks could not be worked out, before anyone has even looked.
    // That is exactly the claim this screen must not make.
    const [state, setState] = useState<BfMarksState>({ loading: true, error: null, data: null });

    const load = useCallback(async () => {
        if (!webpageId) return;
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const body = await api(`/${encodeURIComponent(webpageId)}/bindings`);
            setState({ loading: false, error: null, data: body && body.elements ? body.elements : null });
        } catch (e) {
            setState({ loading: false, error: messageOf(e, 'failed'), data: null });
        }
    }, [webpageId]);

    useEffect(() => {
        // Not fetching is different from fetching: leave the loading state, so
        // the legend does not hang on "working it out".
        if (!enabled || !webpageId) {
            setState(s => (s.loading ? { ...s, loading: false } : s));
            return;
        }
        load();
    }, [enabled, webpageId, reloadKey, load]);

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
