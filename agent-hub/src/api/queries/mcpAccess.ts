// MCP access: named MCP tokens and the organisation's MCP access policy. The
// ONLY place that knows the /api/mcp-tokens and /api/org/mcp-access wire
// contract (server/routes/mcpTokens*.js, server/routes/org/mcpAccess*.js).
//
// A token's plaintext comes back exactly once, in the answer to the create
// call. It is never put in the query cache: the mutation hands it to the
// component that asked, and the list is refetched without it.
//
// Mutations never retry: a retried POST would mint a second token.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';

export type McpServerId = 'integrations' | 'automations' | 'studio' | 'cms';
export type McpLevel = 'read' | 'write';

export interface McpServerScope {
    level: McpLevel;
    /** Optional allow-list of tool names within the server. */
    tools?: string[];
    /** CMS only: may publish / set a site live. */
    publish?: boolean;
}

/** A server absent from the object = no access to that server. */
export type McpScopes = Partial<Record<McpServerId, McpServerScope>>;

export interface McpTokenRecord {
    id: string;
    name: string;
    scopes: McpScopes;
    ipAllowlist: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
    revokedAt: string | null;
    /** Switched off by its owner (reversible). Optional: an older server does not send it. */
    disabledAt?: string | null;
    enabled?: boolean;
}

/** Why a server is not on offer: the operator has not switched it on, or the caller lacks the right to it. */
export type McpUnavailableReason = 'not_enabled' | 'no_access';

export interface McpServerEligibility {
    available: boolean;
    reason?: McpUnavailableReason;
    /** studio: may the caller write? */
    canWrite?: boolean;
    /** cms: may the caller publish? */
    canPublish?: boolean;
}

/** What the caller may put on a token: a token never grants more than its creator can do. */
export interface McpEligibility {
    policy: { allowed: boolean; reason?: 'disabled' | 'user_not_allowed' | 'unavailable' };
    integrations: McpServerEligibility;
    automations: McpServerEligibility;
    studio: McpServerEligibility;
    cms: McpServerEligibility;
}

export interface McpTokensResponse {
    tokens: McpTokenRecord[];
    legacy: { exists: boolean };
    /** Absent from an older server: treat every server as on offer. */
    eligibility?: McpEligibility;
    /** The origin MCP clients reach this server on, for the `claude mcp add` line. */
    mcpBaseUrl?: string;
}

export interface McpTokenCreateInput {
    name: string;
    scopes: McpScopes;
    ipAllowlist?: string[];
    expiresAt?: string | null;
}

export interface McpTokenCreated {
    /** The plaintext token. Shown once; the server keeps only a hash. */
    token: string;
    record: McpTokenRecord;
}

export type McpUserMode = 'all' | 'roles' | 'users';

export interface McpAccessPolicy {
    enabled: boolean;
    ipAllowlist: string[];
    allowedUsers: { mode: McpUserMode; roles: string[]; userIds: string[] };
    rejectLegacyTokens: boolean;
}

export interface McpAccessResponse {
    policy: McpAccessPolicy;
    /** The address this request came from, as the server sees it. */
    callerIp: string | null;
}

/** What an organisation without a stored policy gets (today's behaviour). */
export const DEFAULT_MCP_POLICY: McpAccessPolicy = {
    enabled: true,
    ipAllowlist: [],
    allowedUsers: { mode: 'all', roles: [], userIds: [] },
    rejectLegacyTokens: false,
};

export class McpAccessError extends Error {
    code: string | null;
    status: number | null;
    constructor(message: string, code: string | null, status: number | null) {
        super(message);
        this.name = 'McpAccessError';
        this.code = code;
        this.status = status;
    }
}

export const mcpAccessKeys = {
    all: ['mcp-access'] as const,
    tokens: () => [...mcpAccessKeys.all, 'tokens'] as const,
    policy: () => [...mcpAccessKeys.all, 'policy'] as const,
    members: () => [...mcpAccessKeys.all, 'members'] as const,
};

const NO_RETRY = { retry: false as const };

/** HttpError JSON is { error, code, message }; `error` is sometimes only the code, so prefer a sentence. */
function toError(e: unknown, fallback: string): McpAccessError {
    if (e instanceof McpAccessError) return e;
    if (e instanceof ApiError) {
        const body = (e.body || {}) as { error?: unknown; message?: unknown; code?: unknown };
        const sentence = [body.message, body.error].find((v): v is string => typeof v === 'string' && /\s/.test(v.trim()));
        const code = typeof body.code === 'string' ? body.code : (typeof body.error === 'string' && !/\s/.test(body.error) ? body.error : null);
        return new McpAccessError(sentence || fallback, code, e.status ?? null);
    }
    return new McpAccessError(fallback, null, null);
}

async function call<T>(run: () => Promise<T | null>, fallback: string): Promise<T> {
    try {
        const res = await run();
        if (res === null || res === undefined) throw new McpAccessError(fallback, null, null);
        return res;
    } catch (e) {
        throw toError(e, fallback);
    }
}

export function useMcpTokensQuery() {
    return useQuery<McpTokensResponse, McpAccessError>({
        queryKey: mcpAccessKeys.tokens(),
        queryFn: ({ signal }) => call(() => apiClient.get<McpTokensResponse>('/api/mcp-tokens', { signal }), 'Your MCP tokens could not be loaded.'),
    });
}

export function useCreateMcpToken() {
    const qc = useQueryClient();
    return useMutation<McpTokenCreated, McpAccessError, McpTokenCreateInput>({
        mutationFn: (input) => call(() => apiClient.post<McpTokenCreated>('/api/mcp-tokens', input, NO_RETRY), 'The token could not be created.'),
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpAccessKeys.tokens() }),
    });
}

/**
 * Switch a token off or on. The switch moves at once and goes back if the
 * server refuses; the list is read again either way, so it ends up as the
 * server has it.
 */
export function useSetMcpTokenEnabled() {
    const qc = useQueryClient();
    return useMutation<{ record: McpTokenRecord }, McpAccessError, { id: string; enabled: boolean }, { previous: McpTokensResponse | undefined }>({
        mutationFn: ({ id, enabled }) => call(
            () => apiClient.patch<{ record: McpTokenRecord }>(`/api/mcp-tokens/${encodeURIComponent(id)}`, { enabled }, NO_RETRY),
            'The token could not be switched.',
        ),
        onMutate: async ({ id, enabled }) => {
            await qc.cancelQueries({ queryKey: mcpAccessKeys.tokens() });
            const previous = qc.getQueryData<McpTokensResponse>(mcpAccessKeys.tokens());
            if (previous) {
                qc.setQueryData<McpTokensResponse>(mcpAccessKeys.tokens(), {
                    ...previous,
                    tokens: previous.tokens.map(tok => (tok.id === id
                        ? { ...tok, enabled, disabledAt: enabled ? null : (tok.disabledAt ?? new Date().toISOString()) }
                        : tok)),
                });
            }
            return { previous };
        },
        onError: (_err, _vars, ctx) => {
            if (ctx?.previous) qc.setQueryData(mcpAccessKeys.tokens(), ctx.previous);
        },
        onSettled: () => qc.invalidateQueries({ queryKey: mcpAccessKeys.tokens() }),
    });
}

export function useRevokeMcpToken() {
    const qc = useQueryClient();
    return useMutation<void, McpAccessError, string>({
        mutationFn: async (id) => {
            try {
                await apiClient.delete(`/api/mcp-tokens/${encodeURIComponent(id)}`, NO_RETRY);
            } catch (e) {
                throw toError(e, 'The token could not be revoked.');
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: mcpAccessKeys.tokens() }),
    });
}

export function useMcpAccessQuery() {
    return useQuery<McpAccessResponse, McpAccessError>({
        queryKey: mcpAccessKeys.policy(),
        queryFn: ({ signal }) => call(() => apiClient.get<McpAccessResponse>('/api/org/mcp-access', { signal }), 'The MCP access policy could not be loaded.'),
        // A 403 will not fix itself on retry.
        retry: (count, err) => !(err?.status && err.status < 500) && count < 2,
    });
}

export function useSaveMcpAccess() {
    const qc = useQueryClient();
    return useMutation<{ policy: McpAccessPolicy }, McpAccessError, McpAccessPolicy>({
        mutationFn: (policy) => call(() => apiClient.put<{ policy: McpAccessPolicy }>('/api/org/mcp-access', policy, NO_RETRY), 'The policy could not be saved.'),
        onSuccess: (res) => {
            // Keep the caller's address; only the policy changed.
            qc.setQueryData<McpAccessResponse>(mcpAccessKeys.policy(), (old) => ({ callerIp: old?.callerIp ?? null, policy: res.policy }));
        },
    });
}

/** A member the policy can name. GET /auth/users already returns exactly the members the caller may see. */
export interface McpPickerMember {
    id: string;
    label: string;
    email: string;
}

export function useMcpMembersQuery({ enabled }: { enabled: boolean }) {
    return useQuery<McpPickerMember[], McpAccessError>({
        queryKey: mcpAccessKeys.members(),
        enabled,
        queryFn: async ({ signal }) => {
            const rows = await call(() => apiClient.get<Array<{ id: string; email?: string; username?: string; displayName?: string }>>('/auth/users', { signal }), 'The members could not be loaded.');
            return (Array.isArray(rows) ? rows : []).map(u => ({
                id: u.id,
                label: u.displayName || u.username || u.email || u.id,
                email: u.email || '',
            }));
        },
    });
}
