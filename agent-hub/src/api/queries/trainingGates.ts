// Training gates — the ONLY place that knows the
// /ai/learning/training-gates wire contract.
//
// It used to be a module-level promise plus a resolved snapshot at the top of
// hooks/useTrainingGates. That is a cache keyed on nothing, and logout does
// not reload the page: the next account on the same browser read the previous
// one's course titles and lesson progress until the tab was closed. The same
// fault sessionCaches.ts documents for three other hooks — here it never made
// the list. The shared React Query cache is cleared on logout, so it does now.
//
// `authFetch` rather than `apiClient`: this read fails OPEN, so a non-ok is
// not an exception to be shaped, it is simply "no gates".

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** One area's rule, as /ai/learning/training-gates reports it. */
export interface TrainingGateState {
    enforced?: boolean;
    satisfied?: boolean;
    courseId?: string;
    courseTitle?: string;
    lessonsDone?: number;
    lessonsTotal?: number;
}

export type TrainingGateAreas = Record<string, TrainingGateState>;

export const trainingGateKeys = {
    all: ['training-gates'] as const,
};

/**
 * Fails open in every direction. No answer, a failed fetch, a slow one — all
 * of them mean "not locked", because a client that guesses wrong here either
 * hides a button somebody is entitled to press, or shows one the server will
 * refuse. Of the two, the refusal is recoverable and the hidden button is not.
 */
export async function fetchTrainingGates(signal?: AbortSignal): Promise<TrainingGateAreas> {
    try {
        const res = await authFetch(`${API_BASE}/ai/learning/training-gates`, { signal });
        if (!res.ok) return {};
        const body = await res.json();
        return body?.areas || {};
    } catch {
        return {};
    }
}

export function useTrainingGatesQuery({ enabled = false }: { enabled?: boolean } = {}) {
    return useQuery<TrainingGateAreas, Error>({
        queryKey: trainingGateKeys.all,
        queryFn: ({ signal }) => fetchTrainingGates(signal),
        // Default false: the answer is only needed the moment somebody reaches
        // for a create control, and the New menu is mounted on every Studio
        // screen while being opened on almost none of them.
        enabled,
        // One read per session; `invalidateTrainingGates` is what makes it
        // fresh again, after a lesson is completed.
        staleTime: Infinity,
        retry: false,
    });
}
