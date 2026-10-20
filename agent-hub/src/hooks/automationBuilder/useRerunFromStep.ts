import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchRerunPlan, rerunFromStep } from '../../api/queries/automation/rerun';
import type { RerunSideEffect } from '../../api/queries/automation/rerun';
import { runsKeys } from '../../api/queries/automation/runs';
import { AutomationRequestError } from '../../api/queries/automation/http';

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

interface Options {
    automationId: string;
    t: Translate;
    /** A step id as the person knows it (its label). */
    labelOf: (stepId: string) => string;
    /** Ask whether the steps that send or write may run again. Resolves false when the person says no. */
    confirmSideEffects: (effects: RerunSideEffect[]) => Promise<boolean>;
    /** The new run exists: open it. */
    onStarted: (runId: string) => void;
}

const names = (ids: unknown, labelOf: (id: string) => string): string => {
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    return list.map(labelOf).join(', ');
};

/** The sentence for a refused re-run. Exported for the test. */
export function rerunErrorText(err: unknown, t: Translate, labelOf: (id: string) => string): string {
    if (!(err instanceof AutomationRequestError)) return t('runs.rerun.error_generic', 'Could not re-run from this step.');
    const details = err.details && typeof err.details === 'object' ? err.details as Record<string, unknown> : {};
    switch (err.code) {
        case 'seed_missing_upstream':
            return t('runs.rerun.error_missing', 'This run has no recorded output for {steps}, which this step needs. Pick a run that got that far.', { steps: names(details.stepIds, labelOf) });
        case 'seed_run_synthetic':
            return t('runs.rerun.error_synthetic', 'A dry run has no real data to re-run from. Pick a live run.');
        case 'seed_run_not_found':
            return t('runs.rerun.error_not_found', 'That run could not be found, or you cannot read its data.');
        case 'side_effects_need_confirm':
            return t('runs.rerun.error_confirm', 'This re-run sends or writes outside Bee Flow, so it needs your confirmation. Try again and confirm.');
        default:
            return err.status === 403
                ? t('runs.rerun.error_forbidden', 'You cannot re-run steps of this automation.')
                : t('runs.rerun.error_generic', 'Could not re-run from this step.');
    }
}

/**
 * "Re-run from this step" on a past run: ask the server what it would do, ask
 * the person when that includes steps that send or write, then run it with the
 * data of that run. The refusals the server can still give after the plan (a
 * run that changed in between) read the same way as the plan's own findings.
 */
export default function useRerunFromStep({ automationId, t, labelOf, confirmSideEffects, onStarted }: Options) {
    const qc = useQueryClient();
    const [busyStepId, setBusyStepId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const rerun = useCallback(async (stepId: string, seedRunId: string) => {
        setBusyStepId(stepId);
        setError(null);
        try {
            const plan = await fetchRerunPlan(automationId, stepId, seedRunId);
            if (plan.missingUpstream.length) {
                setError(t('runs.rerun.error_missing', 'This run has no recorded output for {steps}, which this step needs. Pick a run that got that far.', { steps: names(plan.missingUpstream, labelOf) }));
                return;
            }
            const needsConfirm = plan.requiresConfirm || plan.sideEffects.length > 0;
            if (needsConfirm && !await confirmSideEffects(plan.sideEffects)) return;
            const newRunId = await rerunFromStep(automationId, stepId, seedRunId, needsConfirm);
            await qc.invalidateQueries({ queryKey: runsKeys.all });
            if (newRunId) onStarted(newRunId);
        } catch (e) {
            setError(rerunErrorText(e, t, labelOf));
        } finally {
            setBusyStepId(null);
        }
    }, [automationId, t, labelOf, confirmSideEffects, onStarted, qc]);

    return { rerun, busyStepId, error, clearError: useCallback(() => setError(null), []) };
}
