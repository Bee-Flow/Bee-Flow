// The goal of a cowork over /api/cowork/:id/goal (server/usecases/coworkGoals.mts): its sentence and target, the
// check that measures it in plain words, and what the check counted. Drafting the check and approving it go here too.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

type GoalEffect = 'reads' | 'writes' | 'sends';

interface GoalCheckStep { id: string; title: string; type: string; effect: GoalEffect; app: string | null; depth: number }

interface GoalFinding { code: string; stepId: string | null; message: string }

interface GoalCheck {
    automationId: string;
    steps: GoalCheckStep[];
    readsOnly: boolean;
    findings: GoalFinding[];
    fingerprint: string;
}

interface GoalCount { met: number; total: number; percent: number; period: string | null; measuredAt: string | null }

interface GoalResult { runId: string; met: number | null; total: number | null; period: string | null; ok: boolean; error: string | null; measuredAt: string | null }

export interface CoworkGoal {
    sentence: string;
    targetPercent: number;
    check: GoalCheck | null;
    approved: { fingerprint: string; approvedAt: string | null } | null;
    upToDate: boolean;
    count: GoalCount | null;
    results: GoalResult[];
    trend: 'up' | 'down' | 'flat' | null;
}

/** The goal in an answer; null for no goal, and for an answer that carries none. */
const goalIn = (answer: unknown): CoworkGoal | null => {
    const goal = answer && typeof answer === 'object' ? (answer as { goal?: unknown }).goal : null;
    return goal && typeof goal === 'object' && typeof (goal as CoworkGoal).sentence === 'string' ? goal as CoworkGoal : null;
};

export function useCoworkGoal(coworkId: string) {
    const client = useQueryClient();
    const key = ['cowork', 'goal', coworkId] as const;
    const query = useQuery<CoworkGoal | null, Error>({
        queryKey: key,
        queryFn: async () => goalIn(await apiJson<'GET /api/cowork/{id}/goal'>('GET /api/cowork/{id}/goal', { params: { id: coworkId } })),
        retry: false,
    });
    // Every change answers the goal as it now is; the list's goal line reads again.
    const settle = (answer: unknown) => {
        client.setQueryData(key, goalIn(answer));
        void client.invalidateQueries({ queryKey: ['cowork', 'home'] });
    };
    const save = useMutation<unknown, Error, { sentence: string; targetPercent: number }>({
        mutationFn: (body) => apiJson<'PUT /api/cowork/{id}/goal'>('PUT /api/cowork/{id}/goal', { params: { id: coworkId }, body }),
        onSuccess: settle,
    });
    const draft = useMutation<{ summary?: string }, Error, void>({
        mutationFn: () => apiJson<'POST /api/cowork/{id}/goal/check', { summary?: string }>('POST /api/cowork/{id}/goal/check', { params: { id: coworkId }, body: {} }),
        onSuccess: settle,
    });
    const approve = useMutation<unknown, Error, string>({
        mutationFn: (fingerprint) => apiJson<'POST /api/cowork/{id}/goal/approve'>('POST /api/cowork/{id}/goal/approve', { params: { id: coworkId }, body: { fingerprint } }),
        onSuccess: settle,
    });
    const remove = useMutation<unknown, Error, void>({
        mutationFn: () => apiJson<'DELETE /api/cowork/{id}/goal'>('DELETE /api/cowork/{id}/goal', { params: { id: coworkId } }),
        onSuccess: settle,
    });
    return { query, save, draft, approve, remove };
}
