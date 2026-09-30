/**
 * The Studio endpoints: the /api/studio aggregates (mounted behind
 * requireAuthedUser in server/index.js), the per-section lists the
 * "Recently edited" block reads (model/recent.ts names each one), and the
 * "Describe it" router.
 */

import { api, ApiError } from '@/core/api/client';

import { readDescribeIt, readStudioAttention, readStudioCounts, readStudioSearch } from './readers';
import { readRecentRows, RECENT_SOURCES } from './recentSources';
import type { DescribeItAnswer, StudioAttention, StudioCounts, StudioSearch } from '../model/api';
import type { RecentFetch, RecentSourceId } from '../model/recent';

/** The numbers on the Studio rows. Never 403s as a whole: a gated key is simply absent. */
export async function fetchStudioCounts(signal?: AbortSignal): Promise<StudioCounts> {
    return readStudioCounts(await api.get<unknown>('/api/studio/counts', { signal }));
}

/** "Needs attention": cached a minute per user on the server. */
export async function fetchStudioAttention(signal?: AbortSignal): Promise<StudioAttention> {
    return readStudioAttention(await api.get<unknown>('/api/studio/attention', { signal }));
}

/** Name search across the nine Studio kinds. Under two characters no store is touched. */
export async function searchStudio(q: string, signal?: AbortSignal): Promise<StudioSearch> {
    return readStudioSearch(await api.get<unknown>('/api/studio/search', { query: { q }, signal }));
}

/**
 * One section's list, read down to what "Recently edited" draws. A 403 is the
 * server saying "not yours" — refused, not a gap; anything else that fails
 * throws, and the block names the section it could not read.
 */
export async function fetchRecentSource(id: RecentSourceId, signal?: AbortSignal): Promise<RecentFetch> {
    const source = RECENT_SOURCES[id];
    try {
        const body = await api.get<unknown>(source.url, { signal, query: source.query });
        return readRecentRows(id, source.pick(body));
    } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { refused: true };
        throw err;
    }
}

/**
 * "Describe it — AI picks the building blocks": which ONE building block a
 * sentence is about (routes/studio/aiRoute.js). It creates nothing. One
 * fast-tier model call, ten a minute per person: never retried (a 429 is the
 * answer to show, and a timeout may already have spent the call), and given
 * a minute because a self-hosted model can be slow. Null when the body is not
 * an answer at all.
 */
export async function routeDescription(text: string, signal?: AbortSignal): Promise<DescribeItAnswer | null> {
    return readDescribeIt(
        await api.post<unknown>('/api/studio/ai/route', { text }, { signal, retry: false, timeoutMs: 60_000 }),
    );
}
