// The reads the workspace shell needs beyond the project, chat and content
// query modules: the agents the caller can chat with (the composers' agent
// pickers) and the organisation directory (the invite picker).

import { useQuery } from '@tanstack/react-query';
import { ApiError, apiClient } from '../../../api/client';

export interface AgentSummary {
    id: string;
    name?: string;
    icon?: string;
}

export interface DirectoryUser {
    id: string;
    name: string;
    email?: string;
    organizationId?: string;
}

export interface DirectoryGroup {
    id: string;
    name: string;
    organizationId?: string;
}

const agentRows = (rows: unknown): AgentSummary[] => (Array.isArray(rows)
    ? rows.filter((a): a is AgentSummary => !!a && typeof a.id === 'string')
    : []);

/**
 * The two lists the app merges into the agents a person can open, the same
 * way the hub's own agent list does: `/agents` holds the caller's own (drafts
 * included) and the system agents, `/agents/published` the ones published to
 * their organisation or groups. One id once; the published record wins. Only
 * when both reads fail is the list an error: one of them still names agents
 * the person can use.
 */
function mergeUsableAgents(own: unknown, published: unknown): AgentSummary[] {
    const byId = new Map<string, AgentSummary>();
    for (const a of agentRows(own)) byId.set(a.id, a);
    for (const a of agentRows(published)) byId.set(a.id, a);
    return [...byId.values()];
}

/** The agents the caller may chat with: their own, and those published to them. */
export function useUsableAgents(enabled = true) {
    return useQuery<AgentSummary[], Error>({
        queryKey: ['project-home', 'agents'],
        enabled,
        staleTime: 60_000,
        queryFn: async ({ signal }) => {
            const [own, published] = await Promise.allSettled([
                apiClient.get<unknown>('/agents', { signal, retry: false }),
                apiClient.get<unknown>('/agents/published', { signal, retry: false }),
            ]);
            if (own.status === 'rejected' && published.status === 'rejected') throw own.reason;
            return mergeUsableAgents(
                own.status === 'fulfilled' ? own.value : [],
                published.status === 'fulfilled' ? published.value : [],
            );
        },
    });
}

/**
 * A directory list, or `null` when the caller may not read it. Listing users
 * and groups is an admin permission: for everyone else the server answers
 * 403, and the invite form falls back to typing an id. Any other failure is
 * a real error and surfaces as one.
 */
async function directoryList<T>(path: string, signal: AbortSignal | undefined, map: (row: any) => T | null): Promise<T[] | null> {
    try {
        const rows = await apiClient.get<unknown[]>(path, { signal, retry: false });
        return Array.isArray(rows) ? rows.map(map).filter((x): x is T => x !== null) : [];
    } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) return null;
        throw e;
    }
}

export function useDirectoryUsers(enabled = true) {
    return useQuery<DirectoryUser[] | null, Error>({
        queryKey: ['project-home', 'directory', 'users'],
        enabled,
        staleTime: 60_000,
        queryFn: ({ signal }) => directoryList<DirectoryUser>('/auth/users', signal, (u) => (
            u && typeof u.id === 'string' && !u.isSystem
                ? { id: u.id, name: String(u.displayName || u.username || u.email || u.id), email: u.email || undefined, organizationId: u.organizationId || '' }
                : null
        )),
    });
}

export function useDirectoryGroups(enabled = true) {
    return useQuery<DirectoryGroup[] | null, Error>({
        queryKey: ['project-home', 'directory', 'groups'],
        enabled,
        staleTime: 60_000,
        queryFn: ({ signal }) => directoryList<DirectoryGroup>('/auth/groups', signal, (g) => (
            g && typeof g.id === 'string' ? { id: g.id, name: String(g.name || g.id), organizationId: g.organizationId || '' } : null
        )),
    });
}
