// MCP library — the ONLY place that knows the /api/mcp-library wire contract.
//
// Three audiences, one server router (server/routes/mcpLibrary.js):
//   /org/*    organisation admins: their organisation's library
//   /me/*     every member: their own keys for servers that need one
//   /policy   the server administrator: what org admins may install
//
// Mutations never retry. An install or a probe opens a session to a remote
// server the admin picked; repeating one behind their back on a 5xx would
// install twice or hammer a vendor, so a failure is reported, not replayed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';

// ── Types ───────────────────────────────────────────────────────────

export type RemoteMode = 'off' | 'official' | 'allowlist' | 'any';
export type AuthStyle = 'none' | 'bearer' | 'header';
export type CredentialMode = 'shared' | 'personal' | 'none';
export type AccessMode = 'everyone' | 'groups' | 'nobody';

export interface McpTool {
    name: string;
    description: string;
    /** The server's own hint: true = only reads, false = may change data, null = it does not say. */
    readOnly: boolean | null;
    destructive: boolean | null;
    enabled?: boolean;
}

export interface McpAccess {
    mode: AccessMode;
    groupIds: string[];
}

export interface CatalogCredential {
    key: string;
    label: string;
    help: string | null;
    helpUrl: string | null;
}

export interface CatalogEntry {
    id: string;
    name: string;
    description: string;
    category: string;
    url: string;
    host: string | null;
    selfHosted: boolean;
    authStyle: AuthStyle;
    credential: CatalogCredential | null;
    homepage: string | null;
    docsUrl: string | null;
    repository: string | null;
    safetyNote: string | null;
    /** May this org install it under the current server policy? */
    allowed: boolean;
    installedIds: string[];
}

export interface InstalledServer {
    id: string;
    name: string;
    description: string;
    catalogId: string | null;
    docsUrl: string | null;
    url: string | null;
    host: string | null;
    official: boolean;
    status: 'active' | 'disabled' | 'draft';
    blockedByPolicy: boolean;
    blockedReason: string | null;
    authStyle: AuthStyle;
    credential: { key: string; label: string } | null;
    credentialMode: CredentialMode;
    tools: McpTool[];
    enabledToolCount: number;
    access: McpAccess;
    installedAt: string | null;
    installedBy: string | null;
}

export interface ServerWideServer {
    id: string;
    capId: string;
    name: string;
    description: string;
    icon: string | null;
    category: string | null;
    /** 'server' = runs on this Bee Flow server; 'remote' = at the vendor. */
    runsOn: 'server' | 'remote';
    status: string;
    tools: Array<{ name: string; description: string }>;
    toolCount: number;
    credentials: string[];
    /** Inside the org's plan / the server admin's access menu. */
    available: boolean;
    access: McpAccess;
}

export interface LibraryPolicy {
    remote: RemoteMode;
    allowsCustomUrls: boolean;
    allowedHosts: string[];
}

export interface McpLibrary {
    policy: LibraryPolicy;
    isServerAdmin: boolean;
    catalog: CatalogEntry[];
    installed: InstalledServer[];
    serverWide: ServerWideServer[];
    groups: Array<{ id: string; name: string }>;
}

export interface ProbeInput {
    catalogId?: string;
    url?: string;
    auth?: { style: AuthStyle; header?: string };
    credential?: string;
}

export interface ProbeResult {
    url: string;
    tools: McpTool[];
    warnings: string[];
}

export interface InstallInput extends ProbeInput {
    name?: string;
    credentialMode?: 'shared' | 'personal';
    tools?: string[];
    access: { mode: 'everyone' | 'groups'; groupIds?: string[] };
}

export interface UpdateInput {
    enabled?: boolean;
    tools?: string[];
    access?: { mode: 'everyone' | 'groups'; groupIds?: string[] };
    credentialMode?: 'personal';
}

export interface MemberServer {
    id: string;
    name: string;
    description: string;
    catalogId: string | null;
    host: string | null;
    credential: { label: string; help: string | null; helpUrl: string | null };
    sharedKey: boolean;
    connected: boolean;
}

export interface OrgMcpPolicy {
    remote: RemoteMode;
    allowedHosts: string[];
}

// ── Errors ──────────────────────────────────────────────────────────

/** A failure the server explained: its sentence, plus the code the UI can branch on. */
export class McpLibraryError extends Error {
    code: string | null;
    status: number | null;
    constructor(message: string, code: string | null, status: number | null) {
        super(message);
        this.name = 'McpLibraryError';
        this.code = code;
        this.status = status;
    }
}

function toLibraryError(e: unknown, fallback: string): McpLibraryError {
    if (e instanceof ApiError) {
        const body = (e.body || {}) as { error?: string; code?: string };
        // Some gates answer with a bare token for `error` ('feature_locked',
        // 'not_found'): that is a code, not a sentence to show anyone.
        const raw = body.error;
        const isToken = typeof raw === 'string' && /^[a-z][a-z0-9_]*$/.test(raw);
        return new McpLibraryError(isToken || !raw ? fallback : raw, body.code || (isToken ? raw as string : null), e.status ?? null);
    }
    return new McpLibraryError(fallback, null, null);
}

async function call<T>(fn: () => Promise<T | null>, fallback: string): Promise<T> {
    let out: T | null;
    try {
        out = await fn();
    } catch (e) {
        throw toLibraryError(e, fallback);
    }
    if (out === null || out === undefined) throw new McpLibraryError(fallback, null, null);
    return out;
}

// ── Keys ────────────────────────────────────────────────────────────

export const mcpLibraryKeys = {
    all: ['mcp-library'] as const,
    org: () => [...mcpLibraryKeys.all, 'org'] as const,
    me: () => [...mcpLibraryKeys.all, 'me'] as const,
    policy: () => [...mcpLibraryKeys.all, 'policy'] as const,
};

const NO_RETRY = { retry: false as const };

// ── Organisation library ────────────────────────────────────────────

export function useMcpLibraryQuery({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<McpLibrary, McpLibraryError>({
        queryKey: mcpLibraryKeys.org(),
        queryFn: ({ signal }) => call(() => apiClient.get<McpLibrary>('/api/mcp-library/org', { signal }), 'The MCP library could not be loaded.'),
        enabled,
        // A 403 (no licence, not an admin) will not fix itself on retry.
        retry: (count, err) => !(err?.status && err.status < 500) && count < 2,
    });
}

export function useProbeMcpServer() {
    return useMutation<ProbeResult, McpLibraryError, ProbeInput>({
        mutationFn: (input) => call(() => apiClient.post<ProbeResult>('/api/mcp-library/org/probe', input, NO_RETRY), 'The server could not be checked.'),
    });
}

export function useInstallMcpServer() {
    const qc = useQueryClient();
    return useMutation<InstalledServer, McpLibraryError, InstallInput>({
        mutationFn: async (input) => {
            const res = await call(() => apiClient.post<{ server: InstalledServer }>('/api/mcp-library/org/servers', input, NO_RETRY), 'The server could not be installed.');
            return res.server;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}

export function useUpdateMcpServer() {
    const qc = useQueryClient();
    return useMutation<InstalledServer, McpLibraryError, { id: string; patch: UpdateInput }>({
        mutationFn: async ({ id, patch }) => {
            const res = await call(() => apiClient.patch<{ server: InstalledServer }>(`/api/mcp-library/org/servers/${encodeURIComponent(id)}`, patch, NO_RETRY), 'The change could not be saved.');
            return res.server;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}

export function useRefreshMcpServer() {
    const qc = useQueryClient();
    return useMutation<{ server: InstalledServer; newTools: string[] }, McpLibraryError, string>({
        mutationFn: (id) => call(() => apiClient.post<{ server: InstalledServer; newTools: string[] }>(`/api/mcp-library/org/servers/${encodeURIComponent(id)}/refresh`, {}, NO_RETRY), 'The tools could not be checked.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}

export function useSetSharedMcpKey() {
    const qc = useQueryClient();
    return useMutation<{ ok: boolean }, McpLibraryError, { id: string; value: string }>({
        mutationFn: ({ id, value }) => call(() => apiClient.put<{ ok: boolean }>(`/api/mcp-library/org/servers/${encodeURIComponent(id)}/credential`, { value }, NO_RETRY), 'The key could not be saved.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}

export function useUninstallMcpServer() {
    const qc = useQueryClient();
    return useMutation<{ removed: boolean }, McpLibraryError, string>({
        mutationFn: (id) => call(() => apiClient.delete<{ removed: boolean }>(`/api/mcp-library/org/servers/${encodeURIComponent(id)}`, NO_RETRY), 'The server could not be removed.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}

export function useSetServerWideAccess() {
    const qc = useQueryClient();
    return useMutation<{ access: McpAccess }, McpLibraryError, { serverId: string; access: { mode: AccessMode; groupIds?: string[] } }>({
        mutationFn: ({ serverId, access }) => call(() => apiClient.put<{ access: McpAccess }>(`/api/mcp-library/org/server-wide/${encodeURIComponent(serverId)}`, { access }, NO_RETRY), 'The change could not be saved.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}

// ── Members' own keys ───────────────────────────────────────────────

export function useMyMcpServersQuery() {
    return useQuery<MemberServer[], McpLibraryError>({
        queryKey: mcpLibraryKeys.me(),
        queryFn: async ({ signal }) => {
            try {
                const res = await apiClient.get<{ servers: MemberServer[] }>('/api/mcp-library/me', { signal });
                return res?.servers ?? [];
            } catch (e) {
                // Not signed in to an org, or the route is not there on an
                // older server: nothing to connect, which is not an error here.
                if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return [];
                throw toLibraryError(e, 'Your MCP connections could not be loaded.');
            }
        },
    });
}

export function useSaveMyMcpKey() {
    const qc = useQueryClient();
    return useMutation<{ connected: boolean }, McpLibraryError, { id: string; value: string }>({
        mutationFn: ({ id, value }) => call(() => apiClient.put<{ connected: boolean }>(`/api/mcp-library/me/${encodeURIComponent(id)}/credential`, { value }, NO_RETRY), 'Your key could not be saved.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.me() }),
    });
}

export function useDeleteMyMcpKey() {
    const qc = useQueryClient();
    return useMutation<{ connected: boolean }, McpLibraryError, string>({
        mutationFn: (id) => call(() => apiClient.delete<{ connected: boolean }>(`/api/mcp-library/me/${encodeURIComponent(id)}/credential`, NO_RETRY), 'Your key could not be removed.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.me() }),
    });
}

// ── Server policy (server administrators) ───────────────────────────

export interface PolicyPayload {
    policy: OrgMcpPolicy;
    modes: RemoteMode[];
    officialHosts: string[];
}

export function useMcpPolicyQuery({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<PolicyPayload, McpLibraryError>({
        queryKey: mcpLibraryKeys.policy(),
        queryFn: ({ signal }) => call(() => apiClient.get<PolicyPayload>('/api/mcp-library/policy', { signal }), 'The server policy could not be loaded.'),
        enabled,
    });
}

export function useSaveMcpPolicy() {
    const qc = useQueryClient();
    return useMutation<{ policy: OrgMcpPolicy }, McpLibraryError, OrgMcpPolicy>({
        mutationFn: (policy) => call(() => apiClient.put<{ policy: OrgMcpPolicy }>('/api/mcp-library/policy', policy, NO_RETRY), 'The policy could not be saved.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    });
}
