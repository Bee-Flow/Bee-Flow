// The plan of one Cowork item: its read, the three things its owner can do with it, and the
// automations a plan can be made from.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveCoworkPlan, attachCoworkPlan, fixCoworkPlanWiring, getCoworkPlan, getCoworkPlanTry, getCoworkRunTrace, listPlanAutomations, removeCoworkPlan, startCoworkPlanTry } from '../coworkPlanApi';
import type { PlanAutomation, PlanRunTrace, PlanState, PlanTryStart, PlanTryState, PlanWiringFix } from '../coworkPlan.types';

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

/**
 * Cowork fixes the wiring of the plan on screen by itself, once per plan: asked when the plan says it can
 * (`wiringFixable`), never again for the same fingerprint. The plan as it then is replaces what the card shows.
 */
export function useCoworkPlanAutoFix(coworkId: string, state: PlanState | undefined) {
    const client = useQueryClient();
    const fingerprint = state?.wiringFixable ? state.draft?.fingerprint ?? '' : '';
    return useQuery<PlanWiringFix, Error>({
        queryKey: ['cowork', 'plan-fix-wiring', coworkId, fingerprint],
        enabled: !!fingerprint,
        queryFn: async () => {
            const fixed = await fixCoworkPlanWiring(coworkId);
            client.setQueryData(planKey(coworkId), fixed.state);
            return fixed;
        },
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        // Not again for the same plan: not on the next visit, and not after a refusal either ("Fix it for me" asks).
        retryOnMount: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}

/** "Fix it for me": the same fix, asked by the owner. */
export function useCoworkPlanWiringFix(coworkId: string) {
    const client = useQueryClient();
    return useMutation<PlanWiringFix, Error, void>({
        mutationFn: () => fixCoworkPlanWiring(coworkId),
        onSuccess: (fixed) => { client.setQueryData(planKey(coworkId), fixed.state); },
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
 */
export function useCoworkPlanTry(coworkId: string) {
    const start = useMutation<PlanTryStart, Error, void>({ mutationFn: () => startCoworkPlanTry(coworkId) });
    const started = start.data ?? null;
    const follow = useQuery<PlanTryState, Error>({
        queryKey: ['cowork', 'plan-try', coworkId, started?.tryId ?? ''],
        enabled: !!started,
        queryFn: () => getCoworkPlanTry(coworkId, (started as PlanTryStart).tryId),
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

const NO_AUTOMATIONS: PlanAutomation[] = [];

/** The caller's own automations; a refusal (no automations in this organisation) or a failure is none. */
export function usePlanAutomations(enabled: boolean): PlanAutomation[] {
    const query = useQuery<PlanAutomation[]>({
        queryKey: ['cowork', 'plan-automations'],
        enabled,
        staleTime: 30_000,
        retry: false,
        queryFn: async () => {
            try {
                return await listPlanAutomations();
            } catch {
                return NO_AUTOMATIONS;
            }
        },
    });
    return enabled ? query.data ?? NO_AUTOMATIONS : NO_AUTOMATIONS;
}
