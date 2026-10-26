// Reads of the public marketing site: endpoints that need no login and are
// fetched with plain `fetch` (never `authFetch`: a visitor has no session, and
// `credentials: 'omit'` keeps cookies off them). Every reader is fail-soft by
// design, a block that cannot reach its data renders its degraded look, so a
// refusal reads as null and nothing retries.

import { useQuery } from '@tanstack/react-query';

const publicSiteKeys = {
    all: ['public-site'] as const,
    githubStats: () => [...publicSiteKeys.all, 'github-stats'] as const,
    releaseNotes: () => [...publicSiteKeys.all, 'release-notes'] as const,
    plans: (base: string) => [...publicSiteKeys.all, 'plans', base] as const,
    posts: (qs: string) => [...publicSiteKeys.all, 'posts', qs] as const,
    stories: (qs: string) => [...publicSiteKeys.all, 'stories', qs] as const,
    locales: (base: string) => [...publicSiteKeys.all, 'locales', base] as const,
};

/** GET `url` with the browser's own fetch: a public page has no session, so authFetch's token handling has no place here. */
function publicFetch(url: string, signal: AbortSignal | undefined, omitCredentials: boolean): Promise<Response> {
    // eslint-disable-next-line no-restricted-syntax -- public, no-auth endpoints
    return fetch(url, { ...(omitCredentials ? { credentials: 'omit' as const } : {}), signal });
}

/** GET `url`; the JSON body, or null when the server refused. */
async function getPublicJson<T>(url: string, signal?: AbortSignal, omitCredentials = true): Promise<T | null> {
    const res = await publicFetch(url, signal, omitCredentials);
    return res.ok ? ((await res.json()) as T) : null;
}

/** What /api/public/github-stats answers (the server caches GitHub's numbers). */
export interface GithubStatsPayload {
    stars?: number;
    forks?: number;
    latestRelease?: { tag?: string; publishedAt?: string } | null;
    url?: string;
    [key: string]: unknown;
}

/** The server's cached repo numbers; null when unavailable. Shared by every GitHub block on a page. */
export function useGithubStatsQuery() {
    return useQuery<GithubStatsPayload | null>({
        queryKey: publicSiteKeys.githubStats(),
        queryFn: async ({ signal }) => {
            const payload = await getPublicJson<GithubStatsPayload>('/api/public/github-stats', signal);
            return payload && typeof payload === 'object' ? payload : null;
        },
        retry: false,
    });
}

/** The public release notes entries (raw rows); null when unavailable. */
export function useReleaseNotesQuery<T>() {
    return useQuery<T[] | null>({
        queryKey: publicSiteKeys.releaseNotes(),
        queryFn: async ({ signal }) => {
            const payload = await getPublicJson<{ entries?: unknown }>('/api/release-notes/public', signal);
            return payload && Array.isArray(payload.entries) ? (payload.entries as T[]) : null;
        },
        retry: false,
    });
}

/**
 * The public plans. Unlike the other readers a refusal THROWS (the pricing
 * block tells "failed" from "empty"); `base` is the API prefix the caller used
 * ('' for the CMS blocks, API_BASE for the stand-alone pages).
 */
export function usePublicPlansQuery<T>(base: string, omitCredentials: boolean) {
    return useQuery<T[], Error>({
        queryKey: [...publicSiteKeys.plans(base), omitCredentials],
        queryFn: async ({ signal }) => {
            const res = await publicFetch(`${base}/api/billing/public-plans`, signal, omitCredentials);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const payload = await res.json();
            return Array.isArray(payload?.plans) ? payload.plans : [];
        },
        retry: false,
    });
}

/** The newest visible blog posts of the live site, for a query string; null when unavailable. */
export function usePublicBlogPostsQuery<T>(qs: string) {
    return useQuery<T | null>({
        queryKey: publicSiteKeys.posts(qs),
        queryFn: ({ signal }) => getPublicJson<T>(`/api/cms/blog/posts?${qs}`, signal),
        retry: false,
    });
}

/** The live site's published customer stories, for a query string; null when unavailable. */
export function usePublicStoriesQuery(qs: string, enabled: boolean) {
    return useQuery<{ stories?: unknown } | null>({
        queryKey: publicSiteKeys.stories(qs),
        queryFn: ({ signal }) => getPublicJson<{ stories?: unknown }>(`/api/cms/stories?${qs}`, signal),
        enabled,
        retry: false,
    });
}

/** The locales the org enabled (public endpoint, session cookies as sent before); null when unavailable. */
export function usePublicLocalesQuery<T>(base: string, enabled: boolean) {
    return useQuery<T | null>({
        queryKey: publicSiteKeys.locales(base),
        queryFn: ({ signal }) => getPublicJson<T>(`${base}/api/languages/public/locales`, signal, false),
        enabled,
        retry: false,
    });
}
