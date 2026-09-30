// Version history of one notebook or document: the ONLY place that knows the
// uniform versions wire contract. Both item kinds speak it under their own
// base URL (`/api/notebooks/:id` or `/api/studio-documents/:id`), so every
// hook here takes that base and nothing else.
//
//   GET  {base}/versions?cursor=&limit=     → { versions, nextCursor, people? }
//   GET  {base}/versions/:ref               → { version: {…meta, content}, people? }   ref = id | 'current'
//   POST {base}/versions {name}             → { version }   name the CURRENT state
//   PUT  {base}/versions/:ref/name {name}   → { version }   name, rename or clear (null)
//   POST {base}/versions/:ref/restore       → { version, current }

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';

export type VersionSource =
    | 'created' | 'checkpoint' | 'autosave' | 'named' | 'ai' | 'restore' | 'pre_restore' | 'conflict' | 'import' | 'legacy';

export interface VersionContributor {
    /** The person, or for the AI the person it acted for; null when nobody in particular. */
    userId: string | null;
    kind: 'user' | 'ai';
    agentId?: string;
}

export interface VersionStats {
    wordsAdded: number;
    wordsRemoved: number;
    blocksChanged: number;
}

export interface VersionMeta {
    id: string;
    seq: number | null;
    source: VersionSource | string;
    name: string | null;
    createdAt: string;
    createdBy: string | null;
    contributors: VersionContributor[];
    stats: VersionStats | null;
    pinned: boolean;
}

export interface VersionContent {
    html: string;
    markdown: string | null;
}

export interface VersionDetail extends VersionMeta {
    content: VersionContent;
    /** The names the server sent with it (see VersionPeople); empty when none. */
    people?: VersionPeople;
}

/**
 * The names of the people a page of versions mentions, as the server
 * resolved them for the reader's organisation (documents send it; notebooks
 * do not, and then it is empty). Somebody the server did not name is left
 * out, never guessed.
 */
export type VersionPeople = Record<string, { name?: string; email?: string }>;

export interface VersionsPage {
    versions: VersionMeta[];
    nextCursor: string | null;
    people: VersionPeople;
}

/** The ref of "the item as it is now" in every versions route. */
export const CURRENT = 'current';
/** Longest version name the server accepts. */
export const VERSION_NAME_MAX = 80;

const PAGE = 50;
const enc = encodeURIComponent;

export const versionKeys = {
    all: (baseUrl: string) => ['versions', baseUrl] as const,
    list: (baseUrl: string) => ['versions', baseUrl, 'list'] as const,
    one: (baseUrl: string, ref: string) => ['versions', baseUrl, 'one', ref] as const,
};

/** A refused versions request: its status and the server's code, for the screen to word. */
export class VersionRequestError extends Error {
    readonly status: number | null;
    readonly code: string | null;
    constructor(message: string, status: number | null, code: string | null) {
        super(message);
        this.name = 'VersionRequestError';
        this.status = status;
        this.code = code;
    }
}

function toVersionError(e: unknown, fallback: string): Error {
    if (e instanceof ApiError) {
        const body = (e.body && typeof e.body === 'object' ? e.body : {}) as { error?: unknown; code?: unknown };
        return new VersionRequestError(
            typeof body.error === 'string' && body.error ? body.error : fallback,
            e.status ?? null,
            typeof body.code === 'string' ? body.code : null,
        );
    }
    return e instanceof Error ? e : new Error(fallback);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function toStats(raw: unknown): VersionStats | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    return { wordsAdded: num(s.wordsAdded), wordsRemoved: num(s.wordsRemoved), blocksChanged: num(s.blocksChanged) };
}

function toContributors(raw: unknown): VersionContributor[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((c) => c && typeof c === 'object')
        .map((c) => {
            const r = c as Record<string, unknown>;
            const out: VersionContributor = { userId: typeof r.userId === 'string' ? r.userId : null, kind: r.kind === 'ai' ? 'ai' : 'user' };
            if (typeof r.agentId === 'string') out.agentId = r.agentId;
            return out;
        })
        .filter((c) => c.kind === 'ai' || c.userId);
}

/** The `people` map of a versions answer: only entries that name somebody. */
export function toVersionPeople(raw: unknown): VersionPeople {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: VersionPeople = {};
    for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
        if (!p || typeof p !== 'object') continue;
        const { name, email } = p as { name?: unknown; email?: unknown };
        const person: { name?: string; email?: string } = {};
        if (typeof name === 'string' && name.trim()) person.name = name;
        if (typeof email === 'string' && email.trim()) person.email = email;
        if (person.name || person.email) out[id] = person;
    }
    return out;
}

/** Every page's names together (a later page never un-names anybody). */
export function peopleOfPages(pages: ReadonlyArray<Pick<VersionsPage, 'people'>> | null | undefined): VersionPeople {
    return Object.assign({}, ...(pages || []).map((p) => p.people || {}));
}

/** One version's metadata from the wire, with every field present. */
export function toVersionMeta(raw: unknown): VersionMeta | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string') return null;
    return {
        id: r.id,
        seq: typeof r.seq === 'number' ? r.seq : null,
        source: typeof r.source === 'string' ? r.source : 'legacy',
        name: typeof r.name === 'string' && r.name.trim() ? r.name : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
        createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
        contributors: toContributors(r.contributors),
        stats: toStats(r.stats),
        pinned: r.pinned === true,
    };
}

function toVersionDetail(raw: unknown): VersionDetail | null {
    const meta = toVersionMeta(raw);
    if (!meta) return null;
    const content = ((raw as Record<string, unknown>).content || {}) as Record<string, unknown>;
    return {
        ...meta,
        content: {
            html: typeof content.html === 'string' ? content.html : '',
            markdown: typeof content.markdown === 'string' ? content.markdown : null,
        },
    };
}

/** Every version, newest first, a page at a time. */
export function useVersionsQuery(baseUrl: string | null | undefined, enabled = true) {
    return useInfiniteQuery<VersionsPage, Error>({
        queryKey: versionKeys.list(baseUrl || ''),
        enabled: !!baseUrl && enabled,
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor || undefined,
        queryFn: async ({ signal, pageParam }) => {
            try {
                const body = await apiClient.get<{ versions?: unknown[]; nextCursor?: string | null; people?: unknown }>(`${baseUrl}/versions`, {
                    signal, query: { limit: PAGE, cursor: (pageParam as string | null) || undefined },
                });
                return {
                    versions: (body?.versions || []).map(toVersionMeta).filter((v): v is VersionMeta => !!v),
                    nextCursor: typeof body?.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null,
                    people: toVersionPeople(body?.people),
                };
            } catch (e) {
                throw toVersionError(e, 'Could not load the version history');
            }
        },
    });
}

/** The version is not there (any more): deleted, or thinned out of the history. */
export function isVersionGone(error: unknown): boolean {
    return error instanceof VersionRequestError && error.status === 404;
}

/** The client's own retry rule, except that a version that is gone (or refused) is said at once. */
function useRetryUnlessGone() {
    const rule = useQueryClient().getDefaultOptions().queries?.retry;
    return (failures: number, error: Error): boolean => {
        if (isVersionGone(error) || (error instanceof VersionRequestError && error.status === 403)) return false;
        if (typeof rule === 'function') return rule(failures, error);
        if (typeof rule === 'number') return failures < rule;
        return rule !== false && failures < 3;
    };
}

/**
 * One version with its content, or the current state (`ref = 'current'`).
 * A stored version never changes, so it is cached for good; "current" is
 * read fresh every time it is asked for. A version that is gone is said at
 * once, not after the retries a network blip deserves.
 */
export function useVersionQuery(baseUrl: string | null | undefined, ref: string | null | undefined) {
    const retry = useRetryUnlessGone();
    return useQuery<VersionDetail, Error>({
        queryKey: versionKeys.one(baseUrl || '', ref || ''),
        enabled: !!baseUrl && !!ref,
        staleTime: ref === CURRENT ? 0 : Infinity,
        retry,
        queryFn: async ({ signal }) => {
            try {
                const body = await apiClient.get<{ version?: unknown; people?: unknown }>(`${baseUrl}/versions/${enc(ref!)}`, { signal, retry: false });
                const version = toVersionDetail(body?.version);
                if (!version) throw new Error('Could not load this version');
                return { ...version, people: toVersionPeople(body?.people) };
            } catch (e) {
                throw toVersionError(e, 'Could not load this version');
            }
        },
    });
}

/** Name the item's CURRENT state as a version ("Name this version"). */
export function useNameCurrentVersion(baseUrl: string) {
    const qc = useQueryClient();
    return useMutation<VersionMeta, Error, string>({
        mutationFn: async (name) => {
            try {
                const body = await apiClient.post<{ version?: unknown }>(`${baseUrl}/versions`, { name }, { retry: false });
                const version = toVersionMeta(body?.version);
                if (!version) throw new Error('Could not name this version');
                return version;
            } catch (e) {
                throw toVersionError(e, 'Could not name this version');
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: versionKeys.list(baseUrl) }),
    });
}

/** Give a stored version a name, change it, or clear it (`name: null`). */
export function useRenameVersion(baseUrl: string) {
    const qc = useQueryClient();
    return useMutation<VersionMeta, Error, { ref: string; name: string | null }>({
        mutationFn: async ({ ref, name }) => {
            try {
                const body = await apiClient.put<{ version?: unknown }>(`${baseUrl}/versions/${enc(ref)}/name`, { name }, { retry: false });
                const version = toVersionMeta(body?.version);
                if (!version) throw new Error('Could not rename this version');
                return version;
            } catch (e) {
                throw toVersionError(e, 'Could not rename this version');
            }
        },
        onSuccess: (version) => {
            qc.invalidateQueries({ queryKey: versionKeys.list(baseUrl) });
            qc.setQueryData(versionKeys.one(baseUrl, version.id), (prev: VersionDetail | undefined) => (prev ? { ...prev, ...version } : prev));
        },
    });
}

export interface RestoreResult {
    version: VersionMeta | null;
    /** The item as the server now holds it; the host puts it in its editor. */
    current: unknown;
}

/** Make a stored version the current state. The server keeps the state it replaces as a version first. */
export function useRestoreVersion(baseUrl: string) {
    const qc = useQueryClient();
    return useMutation<RestoreResult, Error, { ref: string; expectedVersion?: number | string | null }>({
        mutationFn: async ({ ref, expectedVersion }) => {
            try {
                const body = await apiClient.post<{ version?: unknown; current?: unknown }>(
                    `${baseUrl}/versions/${enc(ref)}/restore`,
                    expectedVersion === undefined || expectedVersion === null ? {} : { expectedVersion },
                    { retry: false },
                );
                return { version: toVersionMeta(body?.version), current: body?.current ?? null };
            } catch (e) {
                throw toVersionError(e, 'Could not restore this version');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: versionKeys.list(baseUrl) });
            qc.invalidateQueries({ queryKey: versionKeys.one(baseUrl, CURRENT) });
        },
    });
}
