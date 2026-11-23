import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { makeCoworkPlan } from '../api/coworkPlanMake';
import { coworkPlanKey } from '../api/queries/coworkPlan';
import type { PlanMakeProgress, PlanStep } from '../api/coworkPlan.types';

/**
 * "Make a plan": have Cowork draft the plan of an item from its brief, and follow the drafting.
 *
 *   const { making, start, cancel } = useCoworkPlanMaker(coworkId);
 *
 * `making` says where it stands: the phase, the steps of the draft so far, and how it ended (the planner's words
 * about the plan, or the sentence of a failure). When a plan comes out it replaces what the plan card shows.
 */
export interface PlanMaking {
    running: boolean;
    phase: PlanMakeProgress['phase'] | null;
    /** The steps of the draft so far. */
    steps: Array<Pick<PlanStep, 'id' | 'title' | 'kind'>>;
    /** What the planner said about the plan it made. */
    summary: string;
    /** The sentence of a failure; '' when it failed without one; null when it did not fail. */
    error: string | null;
}

const IDLE: PlanMaking = { running: false, phase: null, steps: [], summary: '', error: null };

/** The making after one more word from the planner. */
export function afterProgress(making: PlanMaking, progress: PlanMakeProgress): PlanMaking {
    return { ...making, phase: progress.phase, steps: progress.phase === 'drafted' ? progress.steps : making.steps };
}

const isStop = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

export default function useCoworkPlanMaker(coworkId: string) {
    const client = useQueryClient();
    const [making, setMaking] = useState<PlanMaking>(IDLE);
    const stopRef = useRef<AbortController | null>(null);

    const cancel = useCallback(() => {
        stopRef.current?.abort();
        stopRef.current = null;
        setMaking(IDLE);
    }, []);

    const start = useCallback(async () => {
        stopRef.current?.abort();
        const stop = new AbortController();
        stopRef.current = stop;
        setMaking({ ...IDLE, running: true, phase: 'thinking' });
        try {
            const outcome = await makeCoworkPlan(coworkId, { signal: stop.signal, onProgress: (progress) => setMaking((m) => afterProgress(m, progress)) });
            if (stopRef.current !== stop) return;
            if (outcome.state) client.setQueryData(coworkPlanKey(coworkId), outcome.state);
            setMaking((m) => ({ ...m, running: false, phase: null, summary: outcome.summary, error: outcome.error }));
        } catch (e) {
            // A stop is not a failure, and a making that was replaced no longer owns the state.
            if (isStop(e) || stopRef.current !== stop) return;
            setMaking((m) => ({ ...m, running: false, phase: null, error: e instanceof Error ? e.message : '' }));
        }
    }, [coworkId, client]);

    return { making, start, cancel };
}
