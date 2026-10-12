/**
 * The automation and run writes, each owning what it invalidates.
 *
 * A run-level change moves different lists on different screens, so the
 * refreshers below name the exact key sets each screen has always refreshed;
 * a run mutation takes the refresher of the screen it runs on.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
    cancelRun,
    decideRunStep,
    retryRun,
    runAutomation,
    setAutomationActive,
    updateAutomation,
} from '../api/endpoints';
import { automationKeys } from '../api/keys';
import { withSchedule } from '../model/definition';
import { isSettledRunEvent } from '../model/runEvents';
import type { Automation, AutomationRun, RunEvent, RunTriggerResult } from '../model/types';

/** Screen-side reactions, run after the mutation's own invalidation. */
export interface MutationHandlers<TData, TVars = void> {
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (error: Error) => void;
}

// ── Refreshers ──────────────────────────────────────────────────────

/** Everything a run-level event moves on one automation's detail screen. */
export function useAutomationRefresh(id: string): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: automationKeys.activeRuns });
        void queryClient.invalidateQueries({ queryKey: automationKeys.runs(id) });
        void queryClient.invalidateQueries({ queryKey: automationKeys.automation(id) });
        void queryClient.invalidateQueries({ queryKey: automationKeys.recentRuns });
    }, [queryClient, id]);
}

/** Everything a change to one run moves on its own screen. */
export function useRunRefresh(automationId: string, runId: string): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: automationKeys.run(runId) });
        void queryClient.invalidateQueries({ queryKey: automationKeys.runSteps(runId) });
        void queryClient.invalidateQueries({ queryKey: automationKeys.runs(automationId) });
        void queryClient.invalidateQueries({ queryKey: automationKeys.activeRuns });
    }, [queryClient, automationId, runId]);
}

/**
 * The cross-automation run lists, for the tab hub's live feed. Step events never
 * reach this: a busy loop would invalidate twice a second for lists that only
 * show run-level state.
 */
export function useRunListsRefresh(): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: automationKeys.activeRuns });
        void queryClient.invalidateQueries({ queryKey: automationKeys.recentRuns });
    }, [queryClient]);
}

/**
 * The automations list, once a run has ended: each row shows its automation's last
 * status and when it last ran, and the "Last run failed" filter reads them.
 * Only a run's end reaches the list (isSettledRunEvent), so a busy automation's
 * steps never re-read it. The list screen and a detail screen above it both
 * hear the same event, so a read already on its way is joined, not restarted.
 */
export function useSettledRunRefresh(): (event: RunEvent) => void {
    const queryClient = useQueryClient();
    return useCallback(
        (event: RunEvent) => {
            if (!isSettledRunEvent(event)) return;
            void queryClient.invalidateQueries({ queryKey: automationKeys.automations }, { cancelRefetch: false });
        },
        [queryClient],
    );
}

/** An automation's own row and the list it sits in. */
function useAutomationRowRefresh(id: string): () => void {
    const queryClient = useQueryClient();
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: automationKeys.automation(id) });
        void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
    }, [queryClient, id]);
}

// ── Automations ─────────────────────────────────────────────────────

export function useRunAutomation(id: string, handlers: MutationHandlers<RunTriggerResult | null> = {}) {
    const refresh = useAutomationRefresh(id);
    return useMutation({
        mutationFn: () => runAutomation(id),
        onSuccess: (result) => {
            refresh();
            handlers.onSuccess?.(result, undefined);
        },
        onError: handlers.onError,
    });
}

export function useSetAutomationActive(id: string, handlers: MutationHandlers<Automation | null, boolean> = {}) {
    const refresh = useAutomationRowRefresh(id);
    return useMutation({
        mutationFn: async (next: boolean) => (await setAutomationActive(id, next)).automation,
        onSuccess: (updated, next) => {
            refresh();
            handlers.onSuccess?.(updated, next);
        },
    });
}

/** Rename or re-describe. The phone can safely change nothing else by hand. */
export function useUpdateAutomation(id: string, handlers: MutationHandlers<Automation | null, { title: string; description: string }> = {}) {
    const refresh = useAutomationRowRefresh(id);
    return useMutation({
        mutationFn: async (patch: { title: string; description: string }) => (await updateAutomation(id, patch)).automation,
        onSuccess: (updated, patch) => {
            refresh();
            handlers.onSuccess?.(updated, patch);
        },
    });
}

/**
 * Save a new cron. The DEFINITION carries the schedule; the columns are
 * derived from it server-side (see updateAutomation in api/endpoints.ts).
 */
export function useSaveSchedule(
    id: string,
    automation: Automation | null,
    handlers: MutationHandlers<Automation | null, string> = {},
) {
    const refresh = useAutomationRowRefresh(id);
    return useMutation({
        mutationFn: (cron: string) => {
            if (!automation) throw new Error('Not loaded');
            const tz = automation.scheduleTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
            return updateAutomation(id, { definition: withSchedule(automation.definition, cron, tz) }).then((r) => r.automation);
        },
        onSuccess: (updated, cron) => {
            refresh();
            handlers.onSuccess?.(updated, cron);
        },
    });
}

// ── Runs ────────────────────────────────────────────────────────────

/** Ask a run to stop; `refresh` is the screen's refresher from above. */
export function useCancelRun(refresh: () => void, handlers: MutationHandlers<AutomationRun | null, string> = {}) {
    return useMutation({
        mutationFn: (runId: string) => cancelRun(runId),
        onSuccess: (run, runId) => {
            refresh();
            handlers.onSuccess?.(run, runId);
        },
        onError: handlers.onError,
    });
}

/** Approve or reject the step a paused run is waiting on. */
export function useDecideRunStep(runId: string, refresh: () => void, handlers: MutationHandlers<void, 'approve' | 'reject'> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (decision: 'approve' | 'reject') => decideRunStep(runId, decision),
        onSuccess: (data, decision) => {
            refresh();
            // Decided from the run's card: the approvals inbox and badge move too.
            void queryClient.invalidateQueries({ queryKey: automationKeys.approvalLists });
            handlers.onSuccess?.(data, decision);
        },
        onError: handlers.onError,
    });
}

/** Replay a run with its original trigger data. */
export function useRetryRun(automationId: string, runId: string, handlers: MutationHandlers<RunTriggerResult | null> = {}) {
    const refresh = useRunRefresh(automationId, runId);
    return useMutation({
        mutationFn: () => retryRun(automationId, runId),
        onSuccess: (result) => {
            refresh();
            handlers.onSuccess?.(result, undefined);
        },
        onError: handlers.onError,
    });
}
