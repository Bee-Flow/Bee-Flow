// Settings → Usage & Monitoring → Adoption: the six reads of
// GET /api/usage/adoption/*. A non-ok answer is "nothing to show" (null),
// with one exception: a name reveal the server could not record in the
// access audit log answers 503 `audit_unavailable`, and that is surfaced as a
// typed error so the people table can say why it shows nothing instead of
// quietly falling back to pseudonyms.
//
// The response shapes live with the page (pages/settings/usage/adoption/
// adoption.types.ts); this layer may not import from pages/, so the hooks
// take the shape as a type parameter, as api/queries/orgReports.ts does.

import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

const BASE = `${API_BASE}/api/usage/adoption`;
const ROOT = ['settings', 'usage', 'adoption'] as const;

export const adoptionKeys = {
    all: ROOT,
    summary: (qs: string) => [...ROOT, 'summary', qs] as const,
    areas: (qs: string) => [...ROOT, 'areas', qs] as const,
    studio: (qs: string) => [...ROOT, 'studio', qs] as const,
    studioItems: (qs: string, kind: string) => [...ROOT, 'studio-items', kind, qs] as const,
    groups: (qs: string) => [...ROOT, 'groups', qs] as const,
    people: (qs: string, reveal: boolean) => [...ROOT, 'people', reveal ? 'revealed' : 'pseudonymous', qs] as const,
};

/** The server could not write the access-audit row a name reveal needs; it showed nothing. */
export class AdoptionAuditUnavailableError extends Error {
    readonly code = 'audit_unavailable';
    constructor() {
        super('audit_unavailable');
        this.name = 'AdoptionAuditUnavailableError';
    }
}

const PEOPLE_PAGE = 200;

/** `path?qs`, or the bare path when there is no query. */
function urlOf(path: string, qs: string, extra?: Record<string, string>): string {
    const params = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(extra || {})) params.set(k, v);
    const s = params.toString();
    return s ? `${BASE}${path}?${s}` : `${BASE}${path}`;
}

/** The JSON of an ok answer, or null when it was refused or unreadable. */
async function readJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    const res = await authFetch(url, { signal });
    if (!res.ok) return null;
    try { return (await res.json()) as T; } catch { return null; }
}

const READ = { placeholderData: keepPreviousData, retry: false } as const;

/** GET /summary: the hero numbers. */
export function useAdoptionSummary<T>(qs: string) {
    return useQuery<T | null>({
        queryKey: adoptionKeys.summary(qs),
        queryFn: ({ signal }) => readJson<T>(urlOf('/summary', qs), signal),
        ...READ,
    });
}

/** GET /areas: spend per area and the weekly series. */
export function useAdoptionAreas<T>(qs: string) {
    return useQuery<T | null>({
        queryKey: adoptionKeys.areas(qs),
        queryFn: ({ signal }) => readJson<T>(urlOf('/areas', qs), signal),
        ...READ,
    });
}

/** GET /studio: one row per Studio kind. */
export function useAdoptionStudio<T>(qs: string) {
    return useQuery<T | null>({
        queryKey: adoptionKeys.studio(qs),
        queryFn: ({ signal }) => readJson<T>(urlOf('/studio', qs), signal),
        ...READ,
    });
}

/** GET /studio/items?kind=: the drill-down of one kind; idle while no kind is open. */
export function useAdoptionStudioItems<T>(qs: string, kind: string | null) {
    return useQuery<T | null>({
        queryKey: adoptionKeys.studioItems(qs, kind || ''),
        queryFn: ({ signal }) => readJson<T>(urlOf('/studio/items', qs, { kind: String(kind), limit: '200' }), signal),
        enabled: !!kind,
        retry: false,
    });
}

/** GET /groups: adoption per group, the small ones folded. */
export function useAdoptionGroups<T>(qs: string) {
    return useQuery<T | null>({
        queryKey: adoptionKeys.groups(qs),
        queryFn: ({ signal }) => readJson<T>(urlOf('/groups', qs), signal),
        ...READ,
    });
}

interface PeoplePageShape<P> {
    reveal: boolean;
    auditRecorded: boolean;
    people: P[];
    total: number;
    nextCursor: number | null;
}

/** One page of GET /people; a 503 `audit_unavailable` throws the typed error. */
async function readPeoplePage<P>(qs: string, reveal: boolean, cursor: number, signal?: AbortSignal): Promise<PeoplePageShape<P> | null> {
    const extra: Record<string, string> = { limit: String(PEOPLE_PAGE), cursor: String(cursor) };
    if (reveal) extra.reveal = 'true';
    const res = await authFetch(urlOf('/people', qs, extra), { signal });
    if (res.status === 503) {
        const body = await res.json().catch(() => null) as { code?: unknown } | null;
        if (body?.code === 'audit_unavailable') throw new AdoptionAuditUnavailableError();
        return null;
    }
    if (!res.ok) return null;
    try { return (await res.json()) as PeoplePageShape<P>; } catch { return null; }
}

type PeopleData<P> = InfiniteData<PeoplePageShape<P> | null, number>;

/**
 * What a hidden read may show while its own answer loads: the previous
 * answer, but only when no page of it carries names. TanStack hands over the
 * last data the observer had, whatever its key, so after a reveal that would
 * be the revealed page.
 */
export function pseudonymousPlaceholder<P>(prev: PeopleData<P> | undefined): PeopleData<P> | undefined {
    return prev && prev.pages.every(p => !p || !p.reveal) ? prev : undefined;
}

/**
 * GET /people, paged by `nextCursor`; the pages are merged into one list.
 * A revealed read is never retried and never refetched on focus: each request
 * with `reveal=true` writes an access-audit row, so only the person's own
 * click (and the pages they ask for) may cause one. It is also dropped from
 * the cache as soon as nothing shows it (`gcTime: 0`), so the next "Reveal
 * names" asks the server again and is recorded again.
 */
export function useAdoptionPeople<P>(qs: string, reveal: boolean) {
    return useInfiniteQuery({
        queryKey: adoptionKeys.people(qs, reveal),
        initialPageParam: 0,
        getNextPageParam: (last: PeoplePageShape<P> | null) => (last && last.nextCursor != null ? last.nextCursor : undefined),
        queryFn: ({ pageParam, signal }) => readPeoplePage<P>(qs, reveal, pageParam, signal),
        select: (data) => {
            const pages = data.pages.filter((p): p is PeoplePageShape<P> => !!p);
            if (pages.length === 0) return null;
            return {
                reveal: pages[0].reveal,
                auditRecorded: pages.every(p => p.auditRecorded),
                people: pages.flatMap(p => (Array.isArray(p.people) ? p.people : [])),
                total: pages[0].total,
            };
        },
        placeholderData: reveal ? undefined : pseudonymousPlaceholder<P>,
        retry: false,
        refetchOnWindowFocus: !reveal,
        staleTime: reveal ? Infinity : 0,
        ...(reveal ? { gcTime: 0 } : {}),
    });
}
