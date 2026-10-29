// Super-admin server modules (import/remove optional feature modules).
// The ONLY place that knows the /api/admin/modules wire contract — the
// ModulesPanel consumes these hooks and derives display state itself.

import {
    keepPreviousData,
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';
import { type AdminModule, type ModuleMutationResponse, type MarketplacePage, type ConnectResponse, type PurchaseResponse, type RefreshEntitlementsResponse, type InstallProgress, type UpdateResponse, type ModuleHealthRow, type ModulesHealthResponse, type ModuleLogsResponse, type ModuleAuditResponse, type LedgerVersion, type SideloadResponse, type UpdatePolicy, type MarketplaceModuleDetail, type PurchaseVars, type InstallVars, type UpdateVars, type RollbackVars, type SideloadVars, type OfflineGrantVars, type UpdatePolicyVars } from './modules.types';
export {   type AdminModule, type ModuleMutationResponse,      type MarketplacePage, type ConnectResponse, type PurchaseResponse, type RefreshEntitlementsResponse, type InstallProgress, type UpdateResponse,   type ModulesHealthResponse,  type ModuleLogsResponse,  type LedgerVersion, type SideloadResponse, type UpdatePolicy,    type MarketplaceModuleDetail, type PurchaseVars, type InstallVars, type UpdateVars, type RollbackVars, type SideloadVars, type OfflineGrantVars, type UpdatePolicyVars } from './modules.types';

const moduleKeys = {
    all: ['admin-modules'] as const,
    list: () => [...moduleKeys.all, 'list'] as const,
    marketplace: (q: string) => [...moduleKeys.all, 'marketplace', q] as const,
    marketplaceDetail: (id: string) => [...moduleKeys.all, 'marketplace-detail', id] as const,
    installProgress: (id: string) => [...moduleKeys.all, 'install-progress', id] as const,
    health: () => [...moduleKeys.all, 'health'] as const,
    moduleHealth: (id: string) => [...moduleKeys.all, 'health', id] as const,
    logs: (id: string, level: string) => [...moduleKeys.all, 'logs', id, level] as const,
    audit: (moduleId: string) => [...moduleKeys.all, 'audit', moduleId] as const,
    versions: (id: string) => [...moduleKeys.all, 'versions', id] as const,
};

export function useAdminModules() {
    return useQuery<AdminModule[], Error>({
        queryKey: moduleKeys.list(),
        queryFn: ({ signal }) =>
            apiClient
                .get<{ modules: AdminModule[] }>('/api/admin/modules', { signal })
                .then((d) => d?.modules ?? []),
        // Import/remove flips gated surfaces — keep this fresher than the 30s
        // global default so the panel reflects another admin's change quickly.
        staleTime: 10_000,
    });
}

export function useImportModule() {
    const qc = useQueryClient();
    return useMutation<ModuleMutationResponse | null, Error, string>({
        mutationFn: (id) => apiClient.post<ModuleMutationResponse>(`/api/admin/modules/${id}/import`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useRemoveModule() {
    const qc = useQueryClient();
    return useMutation<ModuleMutationResponse | null, Error, string>({
        mutationFn: (id) => apiClient.post<ModuleMutationResponse>(`/api/admin/modules/${id}/remove`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

// ─── Module hub marketplace (remote modules) ────────────────────────────────
// The hub-facing endpoints under /api/admin/modules extend the installed-module
// list above. All are requireSuperAdmin server-side; the panel derives display
// state (buy / entitled / installing / expired / update) from these shapes.

// ─── M1 runtime health / logs / audit ───────────────────────────────────────

// ─── M3/M4 versions / sideload / policy / detail ─────────────────────────────

/** Marketplace media bytes endpoint — usable directly as an <img src>. */
export function moduleMediaUrl(moduleId: string, mediaId: string): string {
    return `${API_BASE}/api/admin/modules/marketplace/${encodeURIComponent(moduleId)}/media/${encodeURIComponent(mediaId)}`;
}

// Browse the hub catalogue. Cursor-paginated (Load more); keepPreviousData so
// the grid doesn't flash empty while a new search query resolves. `connected`
// and `stale` come off the first page and drive the connect/stale banners; a
// 502 { error: 'hub_unavailable' } surfaces as the query error.
export function useMarketplace(q: string, opts: { enabled?: boolean } = {}) {
    return useInfiniteQuery({
        queryKey: moduleKeys.marketplace(q),
        queryFn: ({ pageParam, signal }) =>
            apiClient
                .get<MarketplacePage>('/api/admin/modules/marketplace', {
                    query: { q: q || undefined, cursor: (pageParam as string) || undefined },
                    signal,
                    // The hub round-trip already retries server-side; a 502 here
                    // is a real "hub down" signal we want to show immediately.
                    retry: false,
                })
                .then((d) => d ?? { connected: false, modules: [], nextCursor: null }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last?.nextCursor ?? undefined,
        placeholderData: keepPreviousData,
        enabled: opts.enabled !== false,
        staleTime: 10_000,
    });
}

export function useConnectHub() {
    const qc = useQueryClient();
    return useMutation<ConnectResponse | null, Error, { hubUrl?: string } | void>({
        mutationFn: (vars) => apiClient.post<ConnectResponse>('/api/admin/modules/connect', vars || {}),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useDisconnectHub() {
    const qc = useQueryClient();
    return useMutation<{ ok: true } | null, Error, void>({
        mutationFn: () => apiClient.post<{ ok: true }>('/api/admin/modules/disconnect'),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function usePurchaseModule() {
    const qc = useQueryClient();
    return useMutation<PurchaseResponse | null, Error, PurchaseVars>({
        mutationFn: ({ id, successUrl, cancelUrl }) =>
            apiClient.post<PurchaseResponse>(`/api/admin/modules/${id}/purchase`, { successUrl, cancelUrl }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useRefreshEntitlements() {
    const qc = useQueryClient();
    return useMutation<RefreshEntitlementsResponse | null, Error, void>({
        mutationFn: () => apiClient.post<RefreshEntitlementsResponse>('/api/admin/modules/entitlements/refresh'),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useInstallModule() {
    const qc = useQueryClient();
    return useMutation<{ ok: true } | null, Error, InstallVars>({
        mutationFn: ({ id, version, acceptedPermissions }) =>
            apiClient.post<{ ok: true }>(`/api/admin/modules/${id}/install`, { version, acceptedPermissions }),
        // Progress is polled separately; invalidate so the list reflects the
        // eventual terminal state once it lands.
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

// Poll install progress every 1s until a terminal phase (done | error) or the
// endpoint 404s (no active install on this node). `enabled` lets the caller
// start/stop polling around an install.
export function useInstallProgress(id: string | null, opts: { enabled?: boolean } = {}) {
    return useQuery<InstallProgress | null, Error>({
        queryKey: moduleKeys.installProgress(id || ''),
        queryFn: ({ signal }) =>
            apiClient.get<InstallProgress>(`/api/admin/modules/${id}/install-progress`, { signal, retry: false }),
        enabled: !!id && opts.enabled !== false,
        refetchInterval: (query) => {
            const phase = query.state.data?.phase;
            if (phase === 'done' || phase === 'error') return false;
            // A 404 (no progress record) resolves the query in error — stop polling.
            if (query.state.status === 'error') return false;
            return 1000;
        },
    });
}

export function useUpdateModule() {
    const qc = useQueryClient();
    return useMutation<UpdateResponse | null, Error, UpdateVars>({
        mutationFn: ({ id, acceptedPermissions }) =>
            apiClient.post<UpdateResponse>(`/api/admin/modules/${id}/update`, { acceptedPermissions }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

// ─── M1: runtime health / logs / reactivate / audit ─────────────────────────

export function useModulesHealth(opts: { enabled?: boolean } = {}) {
    return useQuery<ModulesHealthResponse | null, Error>({
        queryKey: moduleKeys.health(),
        queryFn: ({ signal }) =>
            apiClient.get<ModulesHealthResponse>('/api/admin/modules/health', { signal }),
        enabled: opts.enabled !== false,
        staleTime: 5_000,
        // Quarantine / restart chips should follow runtime state on their own.
        refetchInterval: 15_000,
    });
}

function useModuleHealth(id: string | null, opts: { enabled?: boolean } = {}) {
    return useQuery<ModuleHealthRow | null, Error>({
        queryKey: moduleKeys.moduleHealth(id || ''),
        queryFn: ({ signal }) =>
            apiClient.get<ModuleHealthRow>(`/api/admin/modules/${id}/health`, { signal, retry: false }),
        enabled: !!id && opts.enabled !== false,
        staleTime: 5_000,
    });
}

// Ring-buffer logs for one module; polls every 2s while enabled (dialog open).
export function useModuleLogs(
    id: string | null,
    opts: { level?: string | null; limit?: number; enabled?: boolean } = {},
) {
    return useQuery<ModuleLogsResponse | null, Error>({
        queryKey: moduleKeys.logs(id || '', opts.level || 'all'),
        queryFn: ({ signal }) =>
            apiClient.get<ModuleLogsResponse>(`/api/admin/modules/${id}/logs`, {
                query: { limit: opts.limit || 200, level: opts.level || undefined },
                signal,
            }),
        enabled: !!id && opts.enabled !== false,
        refetchInterval: 2_000,
    });
}

export function useReactivateModule() {
    const qc = useQueryClient();
    return useMutation<{ ok: true; version?: string } | null, Error, string>({
        mutationFn: (id) => apiClient.post<{ ok: true; version?: string }>(`/api/admin/modules/${id}/reactivate`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

function useModuleAudit(moduleId?: string | null, opts: { limit?: number; enabled?: boolean } = {}) {
    return useQuery<ModuleAuditResponse | null, Error>({
        queryKey: moduleKeys.audit(moduleId || ''),
        queryFn: ({ signal }) =>
            apiClient.get<ModuleAuditResponse>('/api/admin/modules/audit', {
                query: { moduleId: moduleId || undefined, limit: opts.limit || undefined },
                signal,
            }),
        enabled: opts.enabled !== false,
        staleTime: 10_000,
    });
}

// ─── M3: versions / rollback / sideload / offline grants / staged ───────────

export function useModuleVersions(id: string | null, opts: { enabled?: boolean } = {}) {
    return useQuery<LedgerVersion[], Error>({
        queryKey: moduleKeys.versions(id || ''),
        queryFn: ({ signal }) =>
            apiClient
                .get<{ versions: LedgerVersion[] }>(`/api/admin/modules/${id}/versions`, { signal })
                .then((d) => d?.versions ?? []),
        enabled: !!id && opts.enabled !== false,
        staleTime: 5_000,
    });
}

export function useRollbackModule() {
    const qc = useQueryClient();
    return useMutation<{ ok: true; version: string } | null, Error, RollbackVars>({
        mutationFn: ({ id, version, force }) =>
            apiClient.post<{ ok: true; version: string }>(`/api/admin/modules/${id}/rollback`, { version, force }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

// Sideload posts RAW bytes (application/octet-stream), which apiClient can't
// do (it JSON-serialises bodies) — this is the one direct authFetch call here.
// acceptedPermissions travel as a query param because the body is the package.
export function useSideloadModule() {
    const qc = useQueryClient();
    return useMutation<SideloadResponse | null, Error, SideloadVars>({
        mutationFn: async ({ file, acceptedPermissions }) => {
            const qs = acceptedPermissions?.length
                ? `?acceptedPermissions=${encodeURIComponent(acceptedPermissions.join(','))}`
                : '';
            const res = await authFetch(`${API_BASE}/api/admin/modules/sideload${qs}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file,
            });
            let parsed: (Partial<SideloadResponse> & { error?: string }) | null = null;
            try { parsed = await res.json(); } catch (err) { logger.debug('not JSON', err); }
            if (!res.ok) {
                throw new ApiError(parsed?.error || `HTTP ${res.status}`, { status: res.status, body: parsed });
            }
            return parsed as SideloadResponse;
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useOfflineGrant() {
    const qc = useQueryClient();
    return useMutation<{ ok: true; entitlement: { kind: string; exp: number | null } } | null, Error, OfflineGrantVars>({
        mutationFn: ({ id, grant }) =>
            apiClient.post<{ ok: true; entitlement: { kind: string; exp: number | null } }>(
                `/api/admin/modules/${id}/offline-grant`, grant,
            ),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useActivateStaged() {
    const qc = useQueryClient();
    return useMutation<{ ok: true; version: string } | null, Error, { id: string; version?: string }>({
        mutationFn: ({ id, version }) =>
            apiClient.post<{ ok: true; version: string }>(`/api/admin/modules/${id}/activate-staged`, { version }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

// ─── M4: update policy / marketplace detail ──────────────────────────────────

export function useUpdatePolicy() {
    const qc = useQueryClient();
    return useMutation<{ ok: true; updatePolicy: UpdatePolicy } | null, Error, UpdatePolicyVars>({
        mutationFn: ({ id, channel, pin }) =>
            apiClient.patch<{ ok: true; updatePolicy: UpdatePolicy }>(
                `/api/admin/modules/${id}/update-policy`, { channel, pin },
            ),
        onSuccess: () => { qc.invalidateQueries({ queryKey: moduleKeys.all }); },
    });
}

export function useMarketplaceModuleDetail(id: string | null, opts: { enabled?: boolean } = {}) {
    return useQuery<MarketplaceModuleDetail | null, Error>({
        queryKey: moduleKeys.marketplaceDetail(id || ''),
        queryFn: ({ signal }) =>
            apiClient.get<MarketplaceModuleDetail>(
                `/api/admin/modules/marketplace/${encodeURIComponent(id || '')}`,
                { signal, retry: false },
            ),
        enabled: !!id && opts.enabled !== false,
        staleTime: 10_000,
    });
}
