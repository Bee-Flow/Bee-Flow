import React, { useCallback, useMemo } from 'react';
import type { RunRowData, RunStepRecord } from '../../../../api/queries/automation/runs';
import { useRun, useRunSteps } from '../../../../api/queries/automation/runs';
import { buildRunStepLabelMap, buildRunStepMap, runStepLabel } from '../flow/displayHelpers';
import { useTranslation } from '../../../../hooks/useTranslation';
import useRerunFromStep from '../../../../hooks/automationBuilder/useRerunFromStep';
import type { RerunSideEffect } from '../../../../api/queries/automation/rerun';
import { useBuilderConfirm } from '../BuilderConfirmContext';
import { runStepTypeMap } from './bindingMisses';
import { latestSteps } from './runIo';
import RunDetailHeader from './RunDetailHeader';
import RunTimeline from './RunTimeline';
import RunIo from './RunIo';

interface RunDetailProps {
    automationId: string;
    runId: string;
    seed: RunRowData | null;
    active: boolean;
    selectedStepId: string | null;
    onSelectStep: (stepId: string | null) => void;
    onOpenRun: (runId: string) => void;
    onOpenEditor?: (stepId?: string | null) => void;
    onViewCanvas: () => void;
    onClose: () => void;
    onCompare?: (otherRunId: string) => void;
}

/** The step the right side shows: the picked one, else the last that produced something. */
export function focusStep(rows: RunStepRecord[], selectedStepId: string | null): RunStepRecord | null {
    return rows.find(s => s.stepId === selectedStepId)
        || [...rows].reverse().find(s => s.output != null || s.error)
        || rows[rows.length - 1] || null;
}

/** One run: the sentence, how it came about, and every step's in and out. */
export default function RunDetail({
    automationId, runId, seed, active, selectedStepId, onSelectStep, onOpenRun, onOpenEditor, onViewCanvas, onClose, onCompare,
}: RunDetailProps) {
    const runQuery = useRun(runId, active);
    const stepsQuery = useRunSteps(runId, active);
    const run: RunRowData = { ...(seed || {}), ...(runQuery.data || {}), id: runId };
    const steps = useMemo(() => stepsQuery.data?.steps || [], [stepsQuery.data]);
    const definition = stepsQuery.data?.definition ?? null;
    const labelById = useMemo(() => buildRunStepLabelMap(definition), [definition]);
    const stepById = useMemo(() => buildRunStepMap(definition), [definition]);
    const typeById = useMemo(() => runStepTypeMap(definition), [definition]);
    const rows = useMemo(() => latestSteps(steps), [steps]);
    const step = focusStep(rows, selectedStepId);

    const { t } = useTranslation();
    const confirm = useBuilderConfirm() as (opts: Record<string, unknown>) => Promise<boolean>;
    const labelOf = useCallback((id: string) => String(runStepLabel(labelById, id)), [labelById]);
    const confirmSideEffects = useCallback((effects: RerunSideEffect[]) => confirm({
        title: t('runs.rerun.confirm_title', 'Run these steps again?'),
        description: (
            <div className="flex flex-col gap-2">
                <p>{t('runs.rerun.confirm_body', 'Re-running from here uses the data of this run. These steps would send or write outside Bee Flow again:')}</p>
                <ul className="list-disc pl-5">
                    {effects.map(e => (
                        <li key={e.stepId}>
                            {e.label || labelOf(e.stepId)}
                            {' '}
                            <span className="text-[var(--text-tertiary)]">
                                ({e.effect === 'sends'
                                    ? t('runs.rerun.effect_sends', 'sends something')
                                    : t('runs.rerun.effect_writes', 'writes data')})
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        ),
        confirmLabel: t('runs.rerun.confirm_label', 'Re-run anyway'),
        destructive: true,
    }), [confirm, t, labelOf]);
    const { rerun, busyStepId, error: rerunError, clearError } = useRerunFromStep({
        automationId, t, labelOf, confirmSideEffects, onStarted: onOpenRun,
    });
    const pickStep = useCallback((sid: string | null) => { clearError(); onSelectStep(sid); }, [clearError, onSelectStep]);

    return (
        <div className="h-full min-h-0 flex flex-col text-xs @container/rundetail">
            <RunDetailHeader
                automationId={automationId}
                run={run}
                onOpenRun={onOpenRun}
                onOpenEditor={onOpenEditor}
                onClose={onClose}
                onCompare={onCompare}
                dataHidden={stepsQuery.isError}
            />
            <div className="flex-1 min-h-0 grid grid-cols-1 @[720px]/rundetail:grid-cols-[320px_minmax(0,1fr)] overflow-y-auto @[720px]/rundetail:overflow-visible">
                <RunTimeline
                    run={run}
                    steps={steps}
                    definition={definition}
                    selectedStepId={step?.stepId || null}
                    onSelectStep={pickStep}
                    onViewCanvas={onViewCanvas}
                    onRerunFromStep={(sid) => { void rerun(sid, runId); }}
                    rerunBusyStepId={busyStepId}
                    rerunError={rerunError}
                />
                <RunIo
                    automationId={automationId}
                    step={step}
                    label={step ? String(runStepLabel(labelById, step.stepId)) : ''}
                    stepDef={step ? stepById.get(step.stepId) ?? null : null}
                    labelById={labelById}
                    typeById={typeById}
                />
            </div>
        </div>
    );
}
