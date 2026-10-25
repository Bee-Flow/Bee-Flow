// Support Studio reads. `authFetch` stays inside queryFn: these panels render
// a non-ok answer or a network failure as "nothing there" (the fallback), never
// as an exception, exactly like the effects they replace.

import { keepPreviousData, useInfiniteQuery, type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

const supportKeys = {
    soft: (name: string, ...rest: unknown[]) => ['support-studio', name, ...rest] as const,
    audit: (filters: AuditFilters) => ['support-studio', 'audit', filters] as const,
    access: (inboxId: string | undefined) => ['support-studio', 'access', inboxId ?? null] as const,
};

/** One GET whose failure (non-ok, network, bad JSON) is the `fallback`. `fallback` must be a stable reference. */
function useSoftRead<T>(key: readonly unknown[], url: string, parse: (body: unknown) => T, fallback: T, enabled = true) {
    const query = useQuery<T, Error>({
        queryKey: key,
        enabled,
        queryFn: async () => {
            try {
                const res = await authFetch(url);
                return res.ok ? parse(await res.json()) : fallback;
            } catch {
                return fallback;
            }
        },
        staleTime: 0,
        retry: false,
    });
    return query.data ?? fallback;
}

const asArray = <T>(body: unknown): T[] => (Array.isArray(body) ? body as T[] : []);
const field = <T>(body: unknown, name: string): T[] => {
    const v = (body as Record<string, unknown> | null)?.[name];
    return Array.isArray(v) ? v as T[] : [];
};

const NONE: never[] = [];

export function useSupportAgents<T>(): T[] {
    return useSoftRead<T[]>(supportKeys.soft('agents'), `${API_BASE}/agents/all`, asArray<T>, NONE);
}

export function useSupportKbs<T>(): T[] {
    return useSoftRead<T[]>(
        supportKeys.soft('kbs'), `${API_BASE}/api/kb`,
        (d) => (Array.isArray(d) ? d as T[] : field<T>(d, 'kbs')), NONE,
    );
}

export function useSupportTeammates<T>(): T[] {
    return useSoftRead<T[]>(supportKeys.soft('teammates'), `${API_BASE}/api/support-inbox/teammates`, (d) => field<T>(d, 'teammates'), NONE);
}

export function useSupportTags<T>(): T[] {
    return useSoftRead<T[]>(supportKeys.soft('tags'), `${API_BASE}/api/support-inbox/tags`, (d) => field<T>(d, 'tags'), NONE);
}

export function useSupportCanned<T>(): T[] {
    return useSoftRead<T[]>(supportKeys.soft('canned'), `${API_BASE}/api/support-inbox/canned`, (d) => field<T>(d, 'canned'), NONE);
}

export function useAvailableIntegrations(inboxId: string | undefined, operator: string | undefined): { integrations: string[]; loading: boolean } {
    const enabled = Boolean(operator && inboxId);
    const query = useQuery<string[], Error>({
        queryKey: supportKeys.soft('available-integrations', inboxId ?? null, operator ?? null),
        enabled,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/support-inbox/inboxes/${inboxId}/available-integrations?operator=${encodeURIComponent(operator as string)}`);
                return res.ok ? field<string>(await res.json(), 'integrations') : NONE;
            } catch {
                return NONE;
            }
        },
        staleTime: 0,
        retry: false,
    });
    return { integrations: enabled ? (query.data ?? NONE) : NONE, loading: enabled && query.isFetching };
}

export interface AuditFilters {
    inbox: string;
    actor: string;
    from: string;
    to: string;
}

interface AuditPage<E> {
    events: E[];
    nextCursor: string | null;
}

/** The organisation audit trail, cursor-paginated; `reset()` drops back to the first page and re-reads it. */
export function useAuditEvents<E>(filters: AuditFilters) {
    const queryClient = useQueryClient();
    const query = useInfiniteQuery<AuditPage<E>, Error, InfiniteData<AuditPage<E>, string | null>, ReturnType<typeof supportKeys.audit>, string | null>({
        queryKey: supportKeys.audit(filters),
        initialPageParam: null,
        queryFn: async ({ pageParam }) => {
            const params = new URLSearchParams();
            if (filters.inbox) params.set('inbox', filters.inbox);
            if (filters.actor) params.set('actor', filters.actor);
            if (filters.from) params.set('from', new Date(filters.from).toISOString());
            if (filters.to) params.set('to', new Date(filters.to).toISOString());
            if (pageParam) params.set('cursor', pageParam);
            params.set('limit', '50');
            const res = await authFetch(`${API_BASE}/api/support-inbox/audit?${params.toString()}`);
            const d = await res.json().catch(() => ({ events: [] }));
            return { events: d.events || [], nextCursor: d.nextCursor || null };
        },
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        placeholderData: keepPreviousData,
        staleTime: 0,
        retry: false,
    });
    const pages = query.data?.pages ?? [];
    const key = supportKeys.audit(filters);
    return {
        events: pages.flatMap((p) => p.events),
        nextCursor: pages.length ? pages[pages.length - 1].nextCursor : null,
        loading: query.isFetching,
        loadMore: () => { void query.fetchNextPage(); },
        reset: () => {
            queryClient.setQueryData<InfiniteData<AuditPage<E>, string | null>>(key, (d) => (d ? { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) } : d));
            void query.refetch();
        },
    };
}

/** What an inbox's access read returns (null: not ok, nothing to apply). */
export interface InboxAccessRead {
    mode?: string;
    sharedGroups?: unknown;
    availableGroups?: unknown;
    resolvedMembers?: unknown;
}

export function useInboxAccess(inboxId: string | undefined) {
    const query = useQuery<InboxAccessRead | null, Error>({
        queryKey: supportKeys.access(inboxId),
        enabled: Boolean(inboxId),
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/support-inbox/inboxes/${inboxId}/access`);
            const d = await res.json().catch(() => ({}));
            return res.ok ? d : null;
        },
        staleTime: 0,
        retry: false,
    });
    return { data: query.data ?? null, loading: query.isFetching };
}
