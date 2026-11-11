import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorStatus } from '@/utils/caughtError';
import { studioAppsApi } from '../../studioAppsApi';

/**
 * The app's public URLs and why they may not open yet, from the owner-only
 * public-pages routes. A 403 is not an error here: the routes answer it to a
 * reader who is not the owner, and the tab then shows the list as out of reach
 * instead of a failure.
 */

/** One live URL, as the route reports it. */
export interface PublicPageRow {
    token: string;
    url: string;
    createdAt?: string | null;
    lastSeenAt?: string | null;
    visits?: number | null;
}

/** Why a URL can exist but not open yet (server publicPageBlockers). */
export interface PublicPageBlocker {
    code: string;
    message?: string;
}

export interface PublicPagesState {
    pages: PublicPageRow[];
    blockers: PublicPageBlocker[];
    /** The routes refused this user (not the owner). */
    forbidden: boolean;
}

const keyFor = (appId: string | null | undefined) => ['studio-app', appId, 'public-pages'] as const;

function asRows(raw: unknown): PublicPageRow[] {
    return (Array.isArray(raw) ? raw : []).filter((p): p is PublicPageRow => !!p && typeof p.token === 'string' && typeof p.url === 'string');
}

function asBlockers(raw: unknown): PublicPageBlocker[] {
    return (Array.isArray(raw) ? raw : []).filter((b): b is PublicPageBlocker => !!b && typeof b.code === 'string');
}

export default function usePublicPages(appId: string | null | undefined) {
    const qc = useQueryClient();
    const key = keyFor(appId);
    const query = useQuery({
        queryKey: key,
        queryFn: async (): Promise<PublicPagesState> => {
            try {
                const body = await studioAppsApi.listPublicPages(appId as string);
                return { pages: asRows(body?.pages), blockers: asBlockers(body?.blockers), forbidden: false };
            } catch (err) {
                if (errorStatus(err) === 403) return { pages: [], blockers: [], forbidden: true };
                throw err;
            }
        },
        enabled: !!appId,
        retry: false,
    });
    const refresh = () => qc.invalidateQueries({ queryKey: key });
    const create = useMutation({
        mutationFn: () => studioAppsApi.createPublicPage(appId as string),
        onSettled: refresh,
    });
    const revoke = useMutation({
        mutationFn: (token: string) => studioAppsApi.revokePublicPage(appId as string, token),
        onSettled: refresh,
    });
    return { query, create, revoke };
}
