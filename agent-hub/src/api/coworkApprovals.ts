// The decision a Cowork plan run waits for, as the home's "send" card reads it: the pending approval of the item's
// automation (GET /api/automation/approvals, the viewer's own, narrowed to that automation) and the answer to it
// (POST /api/automation/approvals/:id/decide). Nothing here is Cowork's own route: an approval step of a plan is an
// ordinary approval of the automation the plan is made from.

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

/** The parts of a pending approval the card shows. */
export interface PendingApproval {
    id: string;
    /** What the step asks, in the plan's words. */
    prompt: string;
    /** What it would send, as the step wrote it; null when it wrote nothing. */
    detailsMd: string | null;
}

const asApproval = (row: unknown): PendingApproval | null => {
    if (!row || typeof row !== 'object') return null;
    const r = row as { id?: unknown; prompt?: unknown; detailsMd?: unknown };
    if (typeof r.id !== 'string' || !r.id) return null;
    return { id: r.id, prompt: typeof r.prompt === 'string' ? r.prompt : '', detailsMd: typeof r.detailsMd === 'string' && r.detailsMd ? r.detailsMd : null };
};

/** The newest pending approval of one automation, or null; a refusal (no approvals licence) errors and is not retried. */
export function usePendingApproval(automationId: string | null | undefined) {
    return useQuery<PendingApproval | null, Error>({
        queryKey: ['cowork', 'approval', automationId ?? ''],
        enabled: !!automationId,
        queryFn: async () => {
            const body = await apiJson<'GET /api/automation/approvals', { approvals?: unknown[] }>('GET /api/automation/approvals', {
                query: { scope: 'mine', status: 'pending', limit: 1, automationId: String(automationId) },
            });
            return Array.isArray(body.approvals) ? asApproval(body.approvals[0]) : null;
        },
        staleTime: 15_000,
        retry: false,
    });
}

/** Approve it (the run goes on and sends) or reject it (nothing is sent). */
export function useDecideApproval() {
    return useMutation<unknown, Error, { id: string; decision: 'approve' | 'reject' }>({
        mutationFn: ({ id, decision }) => apiJson('POST /api/automation/approvals/{id}/decide', { params: { id }, body: { decision } }),
    });
}
