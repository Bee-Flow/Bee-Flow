// The plan of one Cowork item: its read, the three things its owner can do with it, and the
// automations a plan can be made from.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveCoworkPlan, attachCoworkPlan, getCoworkPlan, getCoworkPlanTry, getCoworkRunTrace, removeCoworkPlan, startCoworkPlanTry } from '../coworkPlanApi';
import type { PlanRunTrace, PlanState, PlanTryStart, PlanTryState } from '../coworkPlan.types';

/** Where the plan of an item is kept: what replaces it (an approval, a plan Cowork just made) writes here. */
export const coworkPlanKey = (coworkId: string) => ['cowork', 'plan', coworkId] as const;
const planKey = coworkPlanKey;

/** How often the plan is read again while a try-out of it runs by itself (after Cowork fixed its wiring), and how often at most. */
const RUNNING_POLL_MS = 3000;
const RUNNING_POLLS = 60;

/** The plan's try-out of exactly this plan is still running. */
const tryRunning = (state: PlanState | undefined): boolean => state?.tried?.status === 'running' && state.tried.current;

export function useCoworkPlanQuery(coworkId: string | null | undefined) {
    return useQuery<PlanState, Error>({
        queryKey: planKey(coworkId ?? ''),
        enabled: !!coworkId,
        queryFn: () => getCoworkPlan(coworkId as string),
        staleTime: 0,
        retry: false,
        // The card says "Tried once: …" as soon as the try-out is over.
        refetchInterval: (query) => (tryRunning(query.state.data) && query.state.dataUpdateCount < RUNNING_POLLS ? RUNNING_POLL_MS : false),
    });
}

/** What a plan's owner can do. Each answer is the plan as it then is, and replaces what the card shows. */
export function useCoworkPlanActions(coworkId: string) {
    const client = useQueryClient();
    const show = (state: PlanState) => { client.setQueryData(planKey(coworkId), state); };
    const approve = useMutation<PlanState, Error, string>({ mutationFn: (fingerprint) => approveCoworkPlan(coworkId, fingerprint), onSuccess: show });
    const attach = useMutation<PlanState, Error, string>({ mutationFn: (automationId) => attachCoworkPlan(coworkId, automationId), onSuccess: show });
    const remove = useMutation<PlanState, Error, void>({ mutationFn: () => removeCoworkPlan(coworkId), onSuccess: show });
    return { approve, attach, remove };
}

/** How often a try-out that is still going is read again. */
const TRY_POLL_MS = 1200;

/**
 * "Try it first": start a try-out of the item's plan and follow it until it is over. `started` is the try-out this
 * screen started (with the fingerprint of the plan it tries), `state` how it is going; the read repeats while it runs.
 * Once it is over the plan is read again: how it was tested, and what that test produced, are the plan's to say.
 */
export function useCoworkPlanTry(coworkId: string) {
    const client = useQueryClient();
    const start = useMutation<PlanTryStart, Error, void>({ mutationFn: () => startCoworkPlanTry(coworkId) });
    const started = start.data ?? null;
    const follow = useQuery<PlanTryState, Error>({
        queryKey: ['cowork', 'plan-try', coworkId, started?.tryId ?? ''],
        enabled: !!started,
        queryFn: async () => {
            const state = await getCoworkPlanTry(coworkId, (started as PlanTryStart).tryId);
            if (state.done) void client.invalidateQueries({ queryKey: planKey(coworkId) });
            return state;
        },
        refetchInterval: (query) => (query.state.data?.done || query.state.error ? false : TRY_POLL_MS),
        staleTime: 0,
        retry: false,
    });
    return { start, started, state: follow.data ?? null, error: start.error ?? follow.error ?? null };
}

/** How often the steps of a run that is still going are read again. */
const TRACE_POLL_MS = 2500;

/** The steps of one run that followed a plan; read again while the run is still going. */
export function useCoworkRunTrace(coworkId: string, runId: string) {
    return useQuery<PlanRunTrace, Error>({
        queryKey: ['cowork', 'run-trace', coworkId, runId],
        queryFn: () => getCoworkRunTrace(coworkId, runId),
        refetchInterval: (query) => (query.state.data && !query.state.data.done ? TRACE_POLL_MS : false),
        staleTime: 30_000,
        retry: false,
    });
}

