// An agent's test questions with the last run and the limits (GET
// /agents/:id/tests). A refused read is an answer too: its status and body say
// why (a 403 for someone who may only view the agent is not a fault to retry).
// A network failure is the query's error.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../typedRequest';
import { READ_ONCE } from './readOnce';

/** The body on a 2xx; on a refusal the server's error body (null when there is none). */
export type AgentTestsAnswer<B> =
    | { ok: true; status: number; body: B }
    | { ok: false; status: number; body: Record<string, unknown> | null };

/** The parsed body, or null when there is none to read. */
async function bodyOf<B>(res: Response): Promise<B | null> {
    try { return (await res.json()) as B; } catch (_) { return null; }
}

export function useAgentTestsQuery<B>(agentId: string | null, enabled: boolean) {
    return useQuery<AgentTestsAnswer<B>, Error>({
        queryKey: ['agents', agentId, 'tests'],
        enabled: enabled && !!agentId,
        ...READ_ONCE,
        queryFn: async ({ signal }) => {
            const res = await apiFetch('GET /agents/{id}/tests', { params: { id: agentId as string }, init: { signal } });
            if (!res.ok) return { ok: false, status: res.status, body: await bodyOf<Record<string, unknown>>(res) };
            return { ok: true, status: res.status, body: (await res.json()) as B };
        },
    });
}
