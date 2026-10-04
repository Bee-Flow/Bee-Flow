// Server-wide MCP servers — the ONLY place that knows the /ai/mcp-servers and
// /ai/mcp-registry wire contract (server/routes/ai/config/integrations.js).
//
// These are the servers a SERVER administrator installs for every
// organisation. A local (stdio) one is a program this Bee Flow server starts,
// which is why every write here is super-admin only on the server. Each
// organisation then decides in its own MCP library whether it uses them.
//
// Mutations never retry: an install downloads and starts a package, and a
// retried POST would do that twice.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';
import { McpLibraryError, mcpLibraryKeys } from './mcpLibrary';

export interface ServerMcpTool {
    name: string;
    description?: string;
}

export interface ServerMcpServer {
    id: string;
    name: string;
    command?: string | null;
    args?: string[];
    transport?: 'stdio' | 'http';
    url?: string | null;
    category?: string | null;
    description?: string | null;
    icon?: string | null;
    enabled: boolean;
    status?: 'ready' | 'pending_credentials' | 'error' | 'disconnected' | string;
    error?: string | null;
    tools_cache?: ServerMcpTool[];
    required_credentials?: Array<{ key: string; label?: string }>;
    source?: string;
}

/** What POST /ai/mcp-servers takes. */
export interface ServerMcpInstall {
    name: string;
    command?: string;
    args?: string[];
    transport: 'stdio' | 'http';
    url?: string | null;
    category?: string;
    description?: string;
    icon?: string;
    required_credentials?: Array<{ key: string; label: string }>;
    source?: string;
}

/** A card from the curated catalogue or the open registry. */
export interface ServerMcpCandidate extends ServerMcpInstall {
    id?: string;
    verified?: boolean;
    repository?: string | null;
    homepage?: string | null;
    configurable_url?: boolean;
    viewOnly?: boolean;
    bundled?: boolean;
}

export interface ServerMcpTestResult {
    success: boolean;
    tools: ServerMcpTool[];
    error: string | null;
}

export const serverMcpKeys = {
    all: ['server-mcp'] as const,
    list: () => [...serverMcpKeys.all, 'list'] as const,
    registry: (q: string) => [...serverMcpKeys.all, 'registry', q] as const,
};

const NO_RETRY = { retry: false as const };

function toError(e: unknown, fallback: string): McpLibraryError {
    if (e instanceof ApiError) {
        const body = (e.body || {}) as { error?: string; detail?: string; code?: string };
        return new McpLibraryError(body.error === 'mcp_registry_unavailable' ? fallback : (body.error || fallback), body.code || null, e.status ?? null);
    }
    return new McpLibraryError(fallback, null, null);
}

export function useServerMcpQuery({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<ServerMcpServer[], McpLibraryError>({
        queryKey: serverMcpKeys.list(),
        queryFn: async ({ signal }) => {
            try {
                const res = await apiClient.get<{ servers: ServerMcpServer[] }>('/ai/mcp-servers', { signal });
                return res?.servers ?? [];
            } catch (e) {
                throw toError(e, 'The server-wide MCP servers could not be loaded.');
            }
        },
        enabled,
    });
}

/** Every change here also changes what each organisation's library shows. */
function useInvalidateBoth() {
    const qc = useQueryClient();
    return () => Promise.all([
        qc.invalidateQueries({ queryKey: serverMcpKeys.all }),
        qc.invalidateQueries({ queryKey: mcpLibraryKeys.all }),
    ]);
}

export function useInstallServerMcp() {
    const invalidate = useInvalidateBoth();
    return useMutation<ServerMcpServer, McpLibraryError, ServerMcpInstall>({
        mutationFn: async (input) => {
            try {
                const res = await apiClient.post<{ server: ServerMcpServer }>('/ai/mcp-servers', input, NO_RETRY);
                if (!res?.server) throw new McpLibraryError('The server could not be installed.', null, null);
                return res.server;
            } catch (e) {
                if (e instanceof McpLibraryError) throw e;
                throw toError(e, 'The server could not be installed.');
            }
        },
        onSuccess: () => { invalidate(); },
    });
}

export function useTestServerMcp() {
    return useMutation<ServerMcpTestResult, McpLibraryError, { command?: string; args?: string[]; transport: 'stdio' | 'http'; url?: string }>({
        mutationFn: async (input) => {
            try {
                const res = await apiClient.post<ServerMcpTestResult>('/ai/mcp-servers/test', input, NO_RETRY);
                return res ?? { success: false, tools: [], error: null };
            } catch (e) {
                throw toError(e, 'The server could not be tested.');
            }
        },
    });
}

export function useToggleServerMcp() {
    const invalidate = useInvalidateBoth();
    return useMutation<void, McpLibraryError, { id: string; enabled: boolean }>({
        mutationFn: async ({ id, enabled }) => {
            try {
                await apiClient.put(`/ai/mcp-servers/${encodeURIComponent(id)}`, { enabled }, NO_RETRY);
            } catch (e) {
                throw toError(e, 'The change could not be saved.');
            }
        },
        onSuccess: () => { invalidate(); },
    });
}

export function useRefreshServerMcp() {
    const invalidate = useInvalidateBoth();
    return useMutation<ServerMcpTool[], McpLibraryError, string>({
        mutationFn: async (id) => {
            try {
                const res = await apiClient.post<{ tools: ServerMcpTool[] }>(`/ai/mcp-servers/${encodeURIComponent(id)}/refresh`, {}, NO_RETRY);
                return res?.tools ?? [];
            } catch (e) {
                throw toError(e, 'The tools could not be refreshed.');
            }
        },
        onSuccess: () => { invalidate(); },
    });
}

export function useRemoveServerMcp() {
    const invalidate = useInvalidateBoth();
    return useMutation<void, McpLibraryError, string>({
        mutationFn: async (id) => {
            try {
                await apiClient.delete(`/ai/mcp-servers/${encodeURIComponent(id)}`, NO_RETRY);
            } catch (e) {
                throw toError(e, 'The server could not be removed.');
            }
        },
        onSuccess: () => { invalidate(); },
    });
}

/** One page of the open MCP registry (verified, active entries only). */
export async function searchMcpRegistry(q: string, cursor: string | null, signal?: AbortSignal): Promise<{ servers: ServerMcpCandidate[]; nextCursor: string | null }> {
    try {
        const res = await apiClient.get<{ servers: ServerMcpCandidate[]; nextCursor: string | null }>('/ai/mcp-registry/search', {
            signal, query: { q: q || undefined, cursor: cursor || undefined }, retry: false,
        });
        return { servers: res?.servers ?? [], nextCursor: res?.nextCursor ?? null };
    } catch (e) {
        throw toError(e, 'The MCP registry could not be reached.');
    }
}
