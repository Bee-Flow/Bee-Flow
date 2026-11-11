// Small org-admin reads that used to be a hand-written authFetch inside a
// component's useEffect. Each reader keeps the old effect's contract: which
// answers are swallowed (rendered as "nothing") and which are surfaced.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';
import { readOrNull } from './refusableRead';
import { withOrgIdParam } from '../adminOrgScope';
import { messageOf } from '../../utils/caughtError';

const orgAdminReadKeys = {
    directChat: () => ['orgAdmin', 'directChatConfig'] as const,
    connectorHealth: () => ['orgAdmin', 'connectorHealth'] as const,
    groupAccess: (readPath: string) => ['orgAdmin', 'groupAccess', readPath] as const,
};

/** The Direct Chat system prompt. A refusal or a network failure reads as ''. */
export function useDirectChatPrompt() {
    const query = useQuery<string, Error>({
        queryKey: orgAdminReadKeys.directChat(),
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config/direct-chat`);
                if (!res.ok) return '';
                const data = await res.json();
                return data.systemPrompt || '';
            } catch (e) {
                logger.error('Failed to fetch direct chat config:', e);
                return '';
            }
        },
    });
    return { prompt: query.data ?? '', loading: query.isFetching && query.data === undefined };
}

/** GET /auth/admin/connector-health/mine as far as the banner reads it. */
export interface ConnectorHealthProblem {
    code?: string;
    severity?: string;
    message?: string;
    remediation?: string;
}
export interface ConnectorHealth {
    health?: string;
    users?: { pending?: number | string };
    problems?: Array<ConnectorHealthProblem | null>;
}

/** Connector health for the org admin; null on ANY failure (silent-fail contract). */
export function useConnectorHealth(): ConnectorHealth | null {
    const query = useQuery<ConnectorHealth | null, Error>({
        queryKey: orgAdminReadKeys.connectorHealth(),
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/admin/connector-health/mine`);
                if (!res || !res.ok) return null;
                const d = await res.json().catch(() => null);
                return d && typeof d === 'object' ? (d as ConnectorHealth) : null;
            } catch (err) {
                logger.debug('network error → stay silent', err);
                return null;
            }
        },
    });
    return query.data ?? null;
}

/**
 * The group-access payload at `readPath`. A non-ok answer throws `statusError(status)`'s message,
 * a network failure its own message (or `fallback`): the panel shows either as the error text.
 */
export function useGroupAccessRead<T>(
    readPath: string,
    failedStatus: (status: number) => string,
    fallback: string,
) {
    const query = useQuery<T, Error>({
        queryKey: orgAdminReadKeys.groupAccess(readPath),
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            let res: Response;
            try {
                res = await authFetch(readPath);
            } catch (e) {
                throw new Error(messageOf(e, fallback));
            }
            if (!res.ok) throw new Error(failedStatus(res.status));
            try {
                return (await res.json()) as T;
            } catch (e) {
                throw new Error(messageOf(e, fallback));
            }
        },
    });
    return {
        data: query.data ?? null,
        error: query.error ? query.error.message : null,
        loading: query.isFetching && query.data === undefined && !query.error,
    };
}

interface LocaleOption {
    code: string;
    name: string;
}

interface OrgDefaultLanguageData {
    defaultLocale?: string;
    locales?: LocaleOption[];
}

/** The org's default sign-up language and the locales on offer. A failure reads as no locales (the card hides). */
export function useOrgDefaultLanguage() {
    const query = useQuery<OrgDefaultLanguageData | null, Error>({
        queryKey: ['orgAdmin', 'defaultLanguage'] as const,
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            try {
                const r = await authFetch(`${API_BASE}/api/languages/org/default`);
                const data = await r.json();
                return {
                    defaultLocale: data.defaultLocale || undefined,
                    locales: Array.isArray(data.locales) ? data.locales : undefined,
                };
            } catch (e) {
                logger.warn('[OrgInfoPanel] load locales failed', e);
                return null;
            }
        },
    });
    return { data: query.data ?? null, loading: query.isFetching && query.data === undefined };
}

/** GET /auth/invitations (of `orgId`, else the caller's own organisation): the pending invitations; a refusal reads as null (the list keeps empty). */
export function useOrgInvitationsQuery<T>(orgId: string | null = null) {
    return useQuery<T[] | null, Error>({
        queryKey: ['orgAdmin', 'invitations', orgId] as const,
        queryFn: ({ signal }) => readOrNull<T[]>(withOrgIdParam(`${API_BASE}/auth/invitations`, orgId), signal),
        staleTime: 0,
        retry: false,
    });
}

export interface FreeEmailDomains { builtin: string[]; extra: string[] }

/** The cache key of the free-email blocklist, for the save that adopts the server-normalised list. */
export const freeEmailDomainsKey = ['orgAdmin', 'freeEmailDomains'] as const;

/** GET /auth/free-email-domains; a refusal reads as null (the panel says it failed to load). */
function useFreeEmailDomainsQuery() {
    return useQuery<FreeEmailDomains | null, Error>({
        queryKey: freeEmailDomainsKey,
        queryFn: async ({ signal }) => {
            const data = await readOrNull<{ builtin?: unknown; extra?: unknown }>(`${API_BASE}/auth/free-email-domains`, signal);
            if (!data) return null;
            return {
                builtin: Array.isArray(data.builtin) ? data.builtin : [],
                extra: Array.isArray(data.extra) ? data.extra : [],
            };
        },
        staleTime: 0,
        retry: false,
    });
}

const NO_DOMAINS: string[] = [];

/** The blocklist as the panel reads it: both lists (empty until known), whether the first read is pending, and whether it failed or was refused. */
export function useFreeEmailDomains() {
    const query = useFreeEmailDomainsQuery();
    return {
        builtin: query.data?.builtin ?? NO_DOMAINS,
        extra: query.data?.extra ?? NO_DOMAINS,
        loading: query.isPending,
        loadFailed: query.isError || query.data === null,
    };
}

const NO_ROWS: never[] = [];

/**
 * GET /ai/config/custom-tiers-list: the custom tiers' pills. A refusal, an answer without a list
 * or a network failure reads as no tiers. `enabled` false reads nothing.
 */
export function useCustomTiersList<T extends { id: string }>(enabled = true): T[] {
    const query = useQuery<T[], Error>({
        queryKey: ['orgAdmin', 'customTiersList'] as const,
        enabled,
        retry: false,
        staleTime: 0,
        queryFn: async ({ signal }) => {
            try {
                const data = await readOrNull<{ tiers?: T[] }>(`${API_BASE}/ai/config/custom-tiers-list`, signal);
                return Array.isArray(data?.tiers) ? data.tiers : [];
            } catch (err) {
                logger.debug('non-critical', err);
                return [];
            }
        },
    });
    return query.data ?? NO_ROWS;
}

/** One organisation role's grant, as GET /auth/org-roles returns it. */
export interface OrgRoleGrant { id: string; permissions: string[] }
export interface OrgRoleMapping { roles: OrgRoleGrant[]; editablePermissions: string[] }

/** The cache key of `orgId`'s role mapping (null: the caller's own organisation), for a save that splices one role in. */
export const orgRolesKey = (orgId: string | null) => ['orgAdmin', 'orgRoles', orgId] as const;

/** GET /auth/org-roles (of `orgId`, else the caller's own organisation); a refusal reads as no roles. */
export function useOrgRoles(orgId: string | null) {
    const query = useQuery<OrgRoleMapping, Error>({
        queryKey: orgRolesKey(orgId),
        retry: false,
        staleTime: 0,
        queryFn: async ({ signal }) => {
            const body = await readOrNull<{ roles?: OrgRoleGrant[]; editablePermissions?: string[] }>(withOrgIdParam(`${API_BASE}/auth/org-roles`, orgId), signal);
            return { roles: body?.roles || [], editablePermissions: body?.editablePermissions || [] };
        },
    });
    return { mapping: query.data?.roles ?? NO_ROWS, editablePermissions: query.data?.editablePermissions ?? NO_ROWS, loading: query.isPending };
}
