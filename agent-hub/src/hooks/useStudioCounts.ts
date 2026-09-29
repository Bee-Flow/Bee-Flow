import {
    STUDIO_COUNTS_POLL_MS,
    parseStudioCounts,
    studioCountsKeys,
    useStudioCountsQuery,
    type StudioCounts,
} from '../api/queries/studioCounts';
import { queryClient } from '../api/queryClient';

/**
 * useStudioCounts — the per-section item counts the Studio rail shows
 * ("Automations 9", "Tables 3", …) and the "n makers" figure on Studio Home.
 *
 * The wire contract lives in `api/queries/studioCounts`: one request for all
 * nine kinds, a key the caller may not see is simply absent, and `counts` is
 * null until the first response lands.
 *
 * `failed` is the OTHER reason `counts` can be null, and the two must not be
 * told apart by the caller guessing. With `failed` true the honest line is the
 * one the map already has for a key it may not see: no number, and a sentence
 * saying it could not be read. It is reset the moment a read succeeds, so a
 * hiccup does not stick.
 *
 * Polling discipline is React Query's: the interval pauses while the tab is
 * hidden (a signed-in user with the app parked in a background tab all day is
 * the common case) and a focus refetch catches up, which is what the
 * hand-rolled `visibilitychange` listener did.
 *
 * `enabled` false (no Studio row for this user) reports nothing and polls
 * nothing.
 */
export { STUDIO_COUNTS_POLL_MS, parseStudioCounts };
export type { StudioCounts };

export interface StudioCountsState {
    counts: StudioCounts | null;
    makers: number | null;
    failed: boolean;
}

const EMPTY: StudioCountsState = Object.freeze({ counts: null, makers: null, failed: false });

/** The count for one section, or undefined when it is not (yet) known. */
export function countFor(counts: StudioCounts | null | undefined, key: string | null | undefined): number | undefined {
    if (!counts || !key) return undefined;
    const v = counts[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Drop the cached counts — for a screen that just created or deleted one. */
export function invalidateStudioCounts(): void {
    // remove, not reset or invalidate: logout calls this while the old
    // user's screens are still mounted and their session token still set,
    // and either of those would refetch for the old user on the way out.
    queryClient.removeQueries({ queryKey: studioCountsKeys.all });
}

export interface UseStudioCountsOptions {
    enabled?: boolean;
    /** false = fetch ONCE (plus the focus catch-up), no interval. */
    poll?: boolean;
}

/**
 * `poll` false is what Studio's Start screen wants for the "n makers" figure:
 * the rail is already reading this endpoint every 30s for the same body, and a
 * second timer on the same tab would double that request for every open tab to
 * say the same number twice — the reason StudioStart carried no counts at all
 * before Track H3.
 */
export function useStudioCounts({ enabled = true, poll = true }: UseStudioCountsOptions = {}): StudioCountsState {
    const query = useStudioCountsQuery({ enabled, poll });

    if (!enabled) return EMPTY;
    return {
        // The last good numbers stay on screen through a blip — the rail has
        // nothing better to draw, and `failed` is what says the newest read
        // did not land.
        counts: query.data?.counts ?? null,
        makers: query.data?.makers ?? null,
        failed: !!query.error,
    };
}

export default useStudioCounts;
