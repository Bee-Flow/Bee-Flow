// What changed in a project, per reader: the ONLY place that knows the
// /api/projects/:id/changes, /visit and /seen wire contract.
//
// The visit comes first. Opening the workspace posts /visit (and repeats it
// while the page stays open), which is what moves the reader's "since your
// last visit" line; every changes query waits for that answer, so the first
// list the reader sees is already measured from the right moment.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectKeys, type ProjectActivityItem } from './projects';

export type ChangeItemType = 'notebook' | 'document' | 'meeting';
export type ChangeKind = 'edited' | 'added' | 'removed' | 'renamed' | 'restored' | 'named';

export interface ChangeContributor {
    userId: string | null;
    kind: 'user' | 'ai';
}

export interface ChangeStats {
    wordsAdded: number;
    wordsRemoved: number;
    blocksChanged: number;
}

export interface ChangeGroup {
    item: { type: ChangeItemType; id: string; title: string | null; available: boolean };
    lastChangedAt: string | null;
    changeCount: number;
    contributors: ChangeContributor[];
    stats: ChangeStats;
    latestVersionId: string | null;
    /** The version the reader last saw of this item, when known. */
    seenVersionId: string | null;
    /** When the reader last saw it: the moment that stands in when that version is no longer kept. */
    seenAt: string | null;
    kinds: ChangeKind[];
    aiAssisted: boolean;
    /** Only small edits: fine to keep folded. */
    minor: boolean;
    unread: boolean;
}

export interface ProjectChanges {
    groups: ChangeGroup[];
    since: string;
    /** When the reader's previous visit was; null on a first visit. */
    prevVisitAt: string | null;
    visitStartedAt: string | null;
}

export interface ProjectVisit {
    prevVisitAt: string | null;
    visitStartedAt: string | null;
}

/** A row of the "Changes only" activity view: an activity item plus its title, read now. */
export interface ChangeLogItem extends ProjectActivityItem {
    actorKind?: 'user' | 'ai' | 'system';
    itemType?: string | null;
    itemId?: string | null;
    versionId?: string | null;
    updatedAt?: string;
    title?: string | null;
}

const enc = encodeURIComponent;
const LOG_PAGE = 50;
/** How often an open workspace tells the server the visit goes on. */
export const VISIT_PING_MS = 10 * 60 * 1000;

export const changeKeys = {
    all: (projectId: string) => [...projectKeys.project(projectId), 'changes'] as const,
    since: (projectId: string, since: string) => [...projectKeys.project(projectId), 'changes', 'since', since] as const,
    log: (projectId: string) => [...projectKeys.project(projectId), 'changes', 'log'] as const,
    visit: (projectId: string) => [...projectKeys.project(projectId), 'visit'] as const,
};

const ITEM_TYPES = new Set<ChangeItemType>(['notebook', 'document', 'meeting']);
const CHANGE_KINDS = new Set<ChangeKind>(['edited', 'added', 'removed', 'renamed', 'restored', 'named']);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function toGroup(raw: unknown): ChangeGroup | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, any>;
    const item = r.item || {};
    if (!ITEM_TYPES.has(item.type) || typeof item.id !== 'string') return null;
    return {
        item: { type: item.type, id: item.id, title: typeof item.title === 'string' ? item.title : null, available: item.available !== false },
        lastChangedAt: str(r.lastChangedAt),
        changeCount: num(r.changeCount) || 1,
        contributors: (Array.isArray(r.contributors) ? r.contributors : [])
            .filter((c: any) => c && (c.kind === 'ai' || typeof c.userId === 'string'))
            .map((c: any) => ({ userId: typeof c.userId === 'string' ? c.userId : null, kind: c.kind === 'ai' ? 'ai' : 'user' })),
        stats: { wordsAdded: num(r.stats?.wordsAdded), wordsRemoved: num(r.stats?.wordsRemoved), blocksChanged: num(r.stats?.blocksChanged) },
        latestVersionId: str(r.latestVersionId),
        seenVersionId: str(r.seenVersionId),
        seenAt: str(r.seenAt),
        kinds: Array.isArray(r.kinds) ? r.kinds.filter((k: unknown): k is ChangeKind => typeof k === 'string' && CHANGE_KINDS.has(k as ChangeKind)) : [],
        aiAssisted: r.aiAssisted === true,
        minor: r.minor === true,
        unread: r.unread === true,
    };
}

/**
 * The visit: posted when the workspace opens and again every VISIT_PING_MS
 * while it stays open and in view. A query rather than a mutation so that
 * every reader of the page shares ONE visit and can wait for it.
 */
export function useProjectVisitQuery(projectId: string | null | undefined) {
    return useQuery<ProjectVisit, Error>({
        queryKey: changeKeys.visit(projectId || ''),
        enabled: !!projectId,
        staleTime: VISIT_PING_MS,
        refetchInterval: VISIT_PING_MS,
        refetchOnWindowFocus: false,
        retry: false,
        queryFn: async () => {
            const body = await apiClient.post<Partial<ProjectVisit>>(`/api/projects/${enc(projectId!)}/visit`, {}, { retry: false });
            return { prevVisitAt: str(body?.prevVisitAt), visitStartedAt: str(body?.visitStartedAt) };
        },
    });
}

/**
 * What changed since the reader's last visit (`'visit'`), what is still
 * unread (`'unread'`), or since a moment (an ISO time). Waits for the visit.
 */
export function useProjectChangesQuery(projectId: string | null | undefined, since: string = 'visit') {
    const visit = useProjectVisitQuery(projectId);
    const settled = visit.isSuccess || visit.isError;
    return useQuery<ProjectChanges, Error>({
        queryKey: changeKeys.since(projectId || '', since),
        enabled: !!projectId && settled,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<Record<string, unknown>>(`/api/projects/${enc(projectId!)}/changes`, { signal, query: { since } });
            return {
                groups: (Array.isArray(body?.groups) ? body!.groups : []).map(toGroup).filter((g): g is ChangeGroup => !!g),
                since: str(body?.since) || since,
                prevVisitAt: str(body?.prevVisitAt),
                visitStartedAt: str(body?.visitStartedAt),
            };
        },
    });
}

/** The "Changes only" activity view: content rows with their titles, newest session first. */
export function useProjectChangeLogQuery(projectId: string | null | undefined, enabled = true) {
    return useInfiniteQuery<{ items: ChangeLogItem[]; hasMore: boolean }, Error>({
        queryKey: changeKeys.log(projectId || ''),
        enabled: !!projectId && enabled,
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.items.length, 0) : undefined),
        queryFn: async ({ signal, pageParam }) => {
            const body = await apiClient.get<{ items?: ChangeLogItem[]; hasMore?: boolean }>(
                `/api/projects/${enc(projectId!)}/changes/log`,
                { signal, query: { limit: LOG_PAGE, offset: pageParam as number } },
            );
            return { items: Array.isArray(body?.items) ? body!.items : [], hasMore: !!body?.hasMore };
        },
    });
}

/** Take one item out of every cached unread list at once, so its dot goes the moment it is seen. */
function dropUnread(qc: QueryClient, projectId: string, type: ChangeItemType, id: string) {
    qc.setQueriesData<ProjectChanges>({ queryKey: changeKeys.all(projectId) }, (prev) => {
        if (!prev || !Array.isArray(prev.groups)) return prev;
        const groups = prev.since === 'unread'
            ? prev.groups.filter((g) => !(g.item.type === type && g.item.id === id))
            : prev.groups.map((g) => (g.item.type === type && g.item.id === id ? { ...g, unread: false } : g));
        return { ...prev, groups };
    });
}

/** The reader has seen this item (and, when known, this version of it). Quiet: failures are dropped. */
export function useMarkItemSeen(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, { type: ChangeItemType; id: string; versionId?: string | null }>({
        mutationFn: async ({ type, id, versionId }) => {
            await apiClient.post(`/api/projects/${enc(projectId)}/items/${enc(type)}/${enc(id)}/seen`,
                versionId ? { versionId } : {}, { retry: false });
        },
        onMutate: ({ type, id }) => dropUnread(qc, projectId, type, id),
        onSettled: () => qc.invalidateQueries({ queryKey: changeKeys.all(projectId) }),
    });
}

/** "Mark everything as seen". */
export function useMarkAllSeen(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, void>({
        mutationFn: async () => {
            await apiClient.post(`/api/projects/${enc(projectId)}/seen`, {}, { retry: false });
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: changeKeys.all(projectId) }),
    });
}

/** The versions base URL of an item, or null for a kind without a history. */
export function versionsBaseUrl(type: ChangeItemType, id: string): string | null {
    if (type === 'notebook') return `/api/notebooks/${enc(id)}`;
    if (type === 'document') return `/api/studio-documents/${enc(id)}`;
    return null;
}
