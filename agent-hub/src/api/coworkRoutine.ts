// "Make it routine" (server/usecases/coworkRoutine.mts): what an item's past runs did, and the side-by-side proof of a
// try-out of its routine against the last run the AI made.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

interface ToolHabit { tool: string; app: string | null; inRuns: number; callsPerRun: number }
export interface RoutineAdvice {
    applicable: boolean;
    needed: number;
    signals: { runs: number; habits: ToolHabit[]; steady: ToolHabit[]; readsOutsideText: boolean; worthIt: boolean } | null;
}

export interface RoutineComparison {
    before: number; after: number; same: number; onlyBefore: string[]; onlyAfter: string[];
    beforeText: string; afterText: string; beforeMs: number | null; afterMs: number | null;
}

/** Whether the past runs say "make it routine": then it is the first way to a plan the item offers. */
export function isRoutineWorthIt(advice: RoutineAdvice | undefined): boolean {
    return !!advice?.applicable && !!advice.signals?.worthIt;
}

export function useCoworkRoutine(coworkId: string, enabled: boolean) {
    return useQuery<RoutineAdvice, Error>({
        queryKey: ['cowork', 'routine', coworkId],
        enabled,
        queryFn: () => apiJson<'GET /api/cowork/{id}/routine', RoutineAdvice>('GET /api/cowork/{id}/routine', { params: { id: coworkId } }),
        retry: false,
    });
}

/** Read once the try-out is over; an item with no run by the AI answers a refusal, and the proof stays away. */
export function useRoutineComparison(coworkId: string, tryId: string | null, done: boolean) {
    return useQuery<RoutineComparison, Error>({
        queryKey: ['cowork', 'routine-compare', coworkId, tryId],
        enabled: !!tryId && done,
        queryFn: () => apiJson<'GET /api/cowork/{id}/plan/try/{tryId}/compare', RoutineComparison>('GET /api/cowork/{id}/plan/try/{tryId}/compare', { params: { id: coworkId, tryId: String(tryId) } }),
        retry: false,
    });
}
