// Reads of the public marketing site: endpoints that need no login and are
// fetched with plain `fetch` (never `authFetch`: a visitor has no session, and
// `credentials: 'omit'` keeps cookies off them). Every reader is fail-soft by
// design, a block that cannot reach its data renders its degraded look, so a
// refusal reads as null and nothing retries.

import { useQuery } from '@tanstack/react-query';

interface PublicReadOptions<T> {
    /** Public readers wait for a visibility condition; undefined reads as enabled. */
    enabled?: boolean;
    /** False keeps the session cookies on the request (the locales read always sent them). */
    omitCredentials?: boolean;
    /** True makes a refusal an error instead of null (the pricing block tells "failed" from "empty"). */
    strict?: boolean;
    /** Shapes the body; its result is the cached value. A refusal skips it. */
    pick?: (body: unknown) => T;
}

/**
 * ONE fail-soft reader for the public GETs: the JSON body, or null when the
 * server refused. A public page has no session, so this is the browser's own
 * fetch and authFetch's token handling has no place here. The query key is
 * ['public-site', ...key], so a block can be invalidated by prefix.
 */
function usePublicRead<T, R = T | null>(key: readonly unknown[], url: string, options: PublicReadOptions<R> = {}) {
    const { enabled, omitCredentials = true, strict, pick } = options;
    return useQuery<R, Error>({
        queryKey: ['public-site', ...key],
        queryFn: async ({ signal }) => {
            // eslint-disable-next-line no-restricted-syntax -- public, no-auth endpoints
            const res = await fetch(url, { ...(omitCredentials ? { credentials: 'omit' as const } : {}), signal });
            if (!res.ok) {
                if (strict) throw new Error(`HTTP ${res.status}`);
                return null as R;
            }
            const body: unknown = await res.json();
            return pick ? pick(body) : (body as R);
        },
        enabled,
        retry: false,
    });
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
    return usePublicRead<GithubStatsPayload>(['github-stats'], '/api/public/github-stats', {
        pick: (payload) => (payload && typeof payload === 'object' ? (payload as GithubStatsPayload) : null),
    });
}

/** The public release notes entries (raw rows); null when unavailable. */
export function useReleaseNotesQuery<T>() {
    return usePublicRead<T[]>(['release-notes'], '/api/release-notes/public', {
        pick: (payload) => {
            const entries = (payload as { entries?: unknown } | null)?.entries;
            return Array.isArray(entries) ? (entries as T[]) : null;
        },
    });
}

/**
 * The public plans. Unlike the other readers a refusal THROWS (the pricing
 * block tells "failed" from "empty"); `base` is the API prefix the caller used
 * ('' for the CMS blocks, API_BASE for the stand-alone pages).
 */
export function usePublicPlansQuery<T>(base: string, omitCredentials: boolean) {
    return usePublicRead<T, T[]>(['plans', base, omitCredentials], `${base}/api/billing/public-plans`, {
        omitCredentials,
        strict: true,
        pick: (payload) => {
            const plans = (payload as { plans?: unknown } | null)?.plans;
            return Array.isArray(plans) ? (plans as T[]) : [];
        },
    });
}

/** The newest visible blog posts of the live site, for a query string; null when unavailable. */
export function usePublicBlogPostsQuery<T>(qs: string) {
    return usePublicRead<T>(['posts', qs], `/api/cms/blog/posts?${qs}`);
}

/** The live site's published customer stories, for a query string; null when unavailable. */
export function usePublicStoriesQuery(qs: string, enabled: boolean) {
    return usePublicRead<{ stories?: unknown }>(['stories', qs], `/api/cms/stories?${qs}`, { enabled });
}

/** The locales the org enabled (public endpoint, session cookies as sent before); null when unavailable. */
export function usePublicLocalesQuery<T>(base: string, enabled: boolean) {
    return usePublicRead<T>(['locales', base], `${base}/api/languages/public/locales`, { enabled, omitCredentials: false });
}
