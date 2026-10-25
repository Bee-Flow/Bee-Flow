// Reads of the Integrations admin area (feature flags, and the pieces added
// below). Every queryFn keeps the effect's contract: a non-ok answer or a
// network failure is a STATE the panel renders, not an exception.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export const integrationsAdminKeys = {
    featureFlags: ['integrations', 'featureFlags'] as const,
    ncScope: ['integrations', 'ncScope'] as const,
    orgEvents: (orgId: string, severity: string) => ['integrations', 'orgEvents', orgId, severity] as const,
    connectionLending: (resourceType: string, resourceId: string | null | undefined) => ['integrations', 'connectionLending', resourceType, resourceId ?? null] as const,
    ncSync: (orgId: string | null) => ['integrations', 'ncSync', orgId] as const,
    ncSyncOrgId: ['integrations', 'ncSyncOrgId'] as const,
    ncIntegrations: (orgId: string | undefined) => ['integrations', 'ncIntegrations', orgId] as const,
};

/** GET /ai/config. `null` when the answer is not ok or the request failed (callers keep their defaults). */
export function useFeatureFlagsQuery() {
    return useQuery<Record<string, unknown> | null>({
        queryKey: integrationsAdminKeys.featureFlags,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config`);
                return res.ok ? await res.json() : null;
            } catch {
                return null;
            }
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * GET /api/nc-scope: the per-user Nextcloud scope map. Rejects with the
 * server's `error` text (empty message when it sent none, so the panel shows
 * its own default) on a non-ok answer; a network failure rejects with an
 * empty message. Writes go through `mutate` and land in the cache with
 * `setQueryData(integrationsAdminKeys.ncScope, ...)`.
 */
export function useNcScopeQuery<TMap>() {
    return useQuery<TMap | null, Error>({
        queryKey: integrationsAdminKeys.ncScope,
        queryFn: async () => {
            let res: Response;
            try {
                res = await authFetch(`${API_BASE}/api/nc-scope`);
            } catch {
                throw new Error('');
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '');
            return (data.integrations as TMap | undefined) ?? null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The resources an integration can be narrowed to (calendars, boards, ...), or one folder level of Nextcloud Files. */
async function fetchNcScopeResources<TResource>(suffix: string): Promise<TResource[]> {
    let res: Response;
    try {
        res = await authFetch(`${API_BASE}/api/nc-scope/resources/${suffix}`);
    } catch {
        throw new Error('');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : '');
    return data.resources || [];
}

/**
 * Rejects with the server's `error` text (empty when it sent none: the picker shows its default).
 * `enabled` is the lazy trigger (a folder fetches when it is expanded); the answer is kept while
 * mounted, so collapsing and re-expanding a folder does not ask again, but a failure is retried.
 */
export function useNcScopeResourcesQuery<TResource>(integrationId: string, enabled: boolean, folderPath?: string) {
    const suffix = folderPath === undefined ? integrationId : `${integrationId}?path=${encodeURIComponent(folderPath)}`;
    return useQuery<TResource[], Error>({
        queryKey: ['integrations', 'ncScopeResources', integrationId, folderPath ?? null] as const,
        enabled,
        queryFn: () => fetchNcScopeResources<TResource>(suffix),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
}

export interface NcSyncConfig {
    mode?: string;
    syncGroups?: string[];
    excludedGroups?: string[];
    newUserDefaultStatus?: string;
    ncBaseUrl?: string;
    lastSyncAt?: string;
}

export interface NcSyncUser {
    id: string;
    displayName?: string;
    email?: string;
    status: string;
}

interface NcSyncState { config: NcSyncConfig | null; groups: string[]; users: NcSyncUser[] }

/**
 * The org id of the signed-in user, re-read from /auth/user once when the `user` prop carries none
 * (a stale snapshot from the first app mount). `null` until known; stays null on any failure.
 */
export function useFreshOrgIdQuery(enabled: boolean) {
    return useQuery<string | null>({
        queryKey: integrationsAdminKeys.ncSyncOrgId,
        enabled,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/user`);
                const j = res.ok ? await res.json() : null;
                return j?.user?.organizationId || null;
            } catch {
                return null;
            }
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * Nextcloud user/group sync of one org: config, NC groups and synced users. Each part that
 * answers not-ok stays empty; a network failure is logged and leaves everything empty.
 */
export function useNcSyncQuery(orgId: string | null) {
    return useQuery<NcSyncState>({
        queryKey: integrationsAdminKeys.ncSync(orgId),
        enabled: !!orgId,
        queryFn: async () => {
            const state: NcSyncState = { config: null, groups: [], users: [] };
            try {
                const [cfgRes, grpRes, usersRes] = await Promise.all([
                    authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync`),
                    authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync/groups`),
                    authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync/users`),
                ]);
                if (cfgRes.ok) state.config = await cfgRes.json();
                if (grpRes.ok) state.groups = (await grpRes.json()).groups || [];
                if (usersRes.ok) state.users = (await usersRes.json()).users || [];
            } catch (err) {
                console.error('[NcSync] load:', err);
            }
            return state;
        },
        staleTime: 0,
        retry: false,
    });
}

export interface NcCatalogItem {
    id: string;
    name: string;
    description: string;
}

export interface NcIntegrationsConfig {
    ncCatalog?: NcCatalogItem[];
    enabled: string[];
    usingDefaults?: boolean;
}

export interface NcGroup {
    id: string;
    name: string;
    disabledIntegrations?: string[];
    userCount: number;
}

interface NcIntegrationsState { config: NcIntegrationsConfig | null; groups: NcGroup[] }

/** Org-wide Nextcloud integration switches plus the per-group exceptions; not-ok parts stay empty. */
export function useNcIntegrationsQuery(orgId: string | undefined) {
    return useQuery<NcIntegrationsState>({
        queryKey: integrationsAdminKeys.ncIntegrations(orgId),
        enabled: !!orgId,
        queryFn: async () => {
            const state: NcIntegrationsState = { config: null, groups: [] };
            try {
                const [cfgRes, grpRes] = await Promise.all([
                    authFetch(`${API_BASE}/auth/admin/${orgId}/nc-integrations`),
                    authFetch(`${API_BASE}/auth/admin/${orgId}/nc-integrations/groups`),
                ]);
                if (cfgRes.ok) state.config = await cfgRes.json();
                if (grpRes.ok) state.groups = (await grpRes.json()).groups || [];
            } catch (e) {
                console.error('[NcIntegrations] load:', e);
            }
            return state;
        },
        staleTime: 0,
        retry: false,
    });
}

interface NamedConnection {
    id: string;
    provider: string;
    label?: string;
}

interface ConnectionGrant {
    id: string;
    provider: string;
    connection_id: string;
    revoked_at?: string | null;
}

/** provider -> the grant that lends one of the owner's connections for this resource */
interface GrantRef {
    grantId: string;
    connectionId: string;
}

export interface ConnectionLending {
    connsByProvider: Record<string, NamedConnection[]>;
    grantByProvider: Record<string, GrantRef>;
}

const CONNECTIONS_BASE = `${API_BASE}/api/integrations/connections`;

/** The owner's named connections and the active lending grants of one resource. A not-ok part counts as empty. */
export function useConnectionLendingQuery(resourceType: string, resourceId: string | null | undefined, enabled: boolean) {
    return useQuery<ConnectionLending>({
        queryKey: integrationsAdminKeys.connectionLending(resourceType, resourceId),
        enabled: enabled && !!resourceId,
        queryFn: async () => {
            const lending: ConnectionLending = { connsByProvider: {}, grantByProvider: {} };
            try {
                const [cRes, gRes] = await Promise.all([
                    authFetch(CONNECTIONS_BASE),
                    authFetch(`${CONNECTIONS_BASE}/grants?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId as string)}`),
                ]);
                const c: { connections?: NamedConnection[] } = cRes.ok ? await cRes.json() : { connections: [] };
                const g: { grants?: ConnectionGrant[] } = gRes.ok ? await gRes.json() : { grants: [] };
                for (const conn of (c.connections || [])) (lending.connsByProvider[conn.provider] ||= []).push(conn);
                for (const grant of (g.grants || [])) {
                    if (grant.revoked_at) continue;
                    lending.grantByProvider[grant.provider] = { grantId: grant.id, connectionId: grant.connection_id };
                }
            } catch (e) { console.error('[ConnectionPolicyPicker]', e); }
            return lending;
        },
        staleTime: 0,
        retry: false,
    });
}

interface EventsPage<TEvent> { events: TEvent[]; nextCursor: string | null }

const EVENTS_PAGE_SIZE = 50;

/**
 * Keyset-paginated connector-health audit trail of one org. The first page swallows a failure (an
 * empty trail); a failed "load more" rejects, which the timeline renders as "no further page".
 */
export function useOrgEventTimelineQuery<TEvent>(orgId: string, severity: string) {
    return useInfiniteQuery<EventsPage<TEvent>, Error, { events: TEvent[]; nextCursor: string | null }, readonly unknown[], string | null>({
        queryKey: integrationsAdminKeys.orgEvents(orgId, severity),
        initialPageParam: null,
        getNextPageParam: (last) => last.nextCursor,
        queryFn: async ({ pageParam }) => {
            const params = new URLSearchParams();
            params.set('limit', String(EVENTS_PAGE_SIZE));
            if (severity) params.set('severity', severity);
            if (pageParam) params.set('cursor', pageParam);
            try {
                const res = await authFetch(`${API_BASE}/auth/admin/connector-health/${orgId}/events?${params.toString()}`);
                const d = await res.json().catch(() => ({ events: [] }));
                return { events: d.events || [], nextCursor: d.nextCursor || null };
            } catch (err) {
                if (pageParam) throw err;
                return { events: [], nextCursor: null };
            }
        },
        select: (data) => ({
            events: data.pages.flatMap((p) => p.events),
            nextCursor: data.pages[data.pages.length - 1]?.nextCursor ?? null,
        }),
        staleTime: 0,
        retry: false,
    });
}
