// The plan of one Cowork item: its read, the three things its owner can do with it, and the
// automations a plan can be made from.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveCoworkPlan, attachCoworkPlan, getCoworkPlan, getCoworkPlanTry, listPlanAutomations, removeCoworkPlan, startCoworkPlanTry } from '../coworkPlanApi';
import type { PlanAutomation, PlanState, PlanTryStart, PlanTryState } from '../coworkPlan.types';

const planKey = (coworkId: string) => ['cowork', 'plan', coworkId] as const;

export function useCoworkPlanQuery(coworkId: string | null | undefined) {
    return useQuery<PlanState, Error>({
        queryKey: planKey(coworkId ?? ''),
        enabled: !!coworkId,
        queryFn: () => getCoworkPlan(coworkId as string),
        staleTime: 0,
        retry: false,
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
