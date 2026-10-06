import React, { useMemo } from 'react';
import type { RunRowData, RunStepRecord } from '../../../../api/queries/automation/runs';
import { useRun, useRunSteps } from '../../../../api/queries/automation/runs';
import { buildRunStepLabelMap, buildRunStepMap, runStepLabel } from '../flow/displayHelpers';
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
}

/** The step the right side shows: the picked one, else the last that produced something. */
export function focusStep(rows: RunStepRecord[], selectedStepId: string | null): RunStepRecord | null {
    return rows.find(s => s.stepId === selectedStepId)
        || [...rows].reverse().find(s => s.output != null || s.error)
        || rows[rows.length - 1] || null;
}

/** One run: the sentence, how it came about, and every step's in and out. */
export default function RunDetail({
    automationId, runId, seed, active, selectedStepId, onSelectStep, onOpenRun, onOpenEditor, onViewCanvas, onClose,
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

    return (
        <div className="h-full min-h-0 flex flex-col text-xs @container/rundetail">
            <RunDetailHeader automationId={automationId} run={run} onOpenRun={onOpenRun} onOpenEditor={onOpenEditor} onClose={onClose} />
            <div className="flex-1 min-h-0 grid grid-cols-1 @[720px]/rundetail:grid-cols-[320px_minmax(0,1fr)] overflow-y-auto @[720px]/rundetail:overflow-visible">
                <RunTimeline
                    run={run}
                    steps={steps}
                    definition={definition}
                    selectedStepId={step?.stepId || null}
                    onSelectStep={onSelectStep}
                    onViewCanvas={onViewCanvas}
                />
                <RunIo
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
