/**
 * Runs from the editor. Each saves the draft first — the server runs the
 * STORED definition — and a new routine is created for the purpose. `flowKey`
 * is the routine id, or a new routine's draft key (FlowDraft.key).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { runAutomation, type MutationHandlers, type RunInput, type RunTriggerResult } from '@/features/automations';

import { refreshRunLists } from './cacheSync';
import { dryRun, runStep, type TestRunInput } from '../api/runs';
import type { StepRunMode, StepRunResult, TestRunResult } from '../api/types';
import { ensureDraftSaved } from '../state/ensureSaved';

export interface StepRunVars extends TestRunInput {
    stepId: string;
    /** 'only' (default): this step with replayed input; 'from': it and everything after; 'upTo': the flow up to it. */
    mode?: StepRunMode;
}

/** "Test this step", "Run from here", "Run up to here". */
export function useStepRun(flowKey: string, handlers: MutationHandlers<StepRunResult, StepRunVars> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ stepId, mode = 'only', ...input }: StepRunVars) => {
            const id = await ensureDraftSaved(flowKey);
            const result = await runStep(id, stepId, mode, input);
            refreshRunLists(queryClient, id);
            return result;
        },
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

/** A dry run of the whole flow: side-effecting tools are simulated, the rest runs. */
export function useDryRun(flowKey: string, handlers: MutationHandlers<TestRunResult, TestRunInput | void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: TestRunInput | void) => {
            const id = await ensureDraftSaved(flowKey);
            const result = await dryRun(id, input ?? {});
            refreshRunLists(queryClient, id);
            return result;
        },
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

/**
 * Run the whole flow for real — the web run menu's "Run live": every step
 * performs its action. The caller asks first. The call is the automations
 * feature's own (one function per server call).
 */
export function useLiveRun(flowKey: string, handlers: MutationHandlers<RunTriggerResult | null, RunInput | void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: RunInput | void) => {
            const id = await ensureDraftSaved(flowKey);
            const result = await runAutomation(id, input ?? {});
            refreshRunLists(queryClient, id);
            return result;
        },
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}
