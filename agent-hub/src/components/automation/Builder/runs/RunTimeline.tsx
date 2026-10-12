import React, { useMemo } from 'react';
import { Check, Hourglass, Loader2, Minus, SearchX, Workflow, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { RunRowData, RunStepRecord } from '../../../../api/queries/automation/runs';
import { buildRunStepLabelMap, runStepLabel } from '../flow/displayHelpers';
import { clockTime, formatSeconds, howStartedText } from './runOutcome';
import { latestSteps, stepDuration, stepResult } from './runIo';
import { stepBindingWarnings } from './bindingMisses';

interface RunTimelineProps {
    run: RunRowData;
    steps: RunStepRecord[];
    definition: unknown;
    selectedStepId: string | null;
    onSelectStep: (stepId: string | null) => void;
    onViewCanvas: () => void;
}

function Dot({ status, selected }: { status: string; selected: boolean }) {
    const s = status.toLowerCase();
    let Icon = Check;
    let cls = 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]';
    if (s === 'error' || s === 'failed') { Icon = X; cls = 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]'; }
    else if (s.startsWith('awaiting')) { Icon = Hourglass; cls = 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]'; }
    else if (s === 'running' || s === 'queued') { Icon = Loader2; cls = 'bg-[var(--bg-tertiary)] text-[var(--accent-primary)]'; }
    else if (s === 'skipped') { Icon = Minus; cls = 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'; }
    if (selected) cls = 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';
    return (
        <span className={`w-5 h-5 rounded-full grid place-items-center shrink-0 ${cls}`}>
            <Icon size={12} className={s === 'running' && !selected ? 'animate-spin' : ''} />
        </span>
    );
}

/** "What happened": the start, then every step with what it produced. */
export default function RunTimeline({ run, steps, definition, selectedStepId, onSelectStep, onViewCanvas }: RunTimelineProps) {
    const { t, locale } = useTranslation();
    const labelById = useMemo(() => buildRunStepLabelMap(definition), [definition]);
    const rows = useMemo(() => latestSteps(steps), [steps]);

    return (
        <div className="px-5 py-4 flex flex-col min-h-0 overflow-y-auto custom-scrollbar border-r border-[var(--border-default)] text-xs">
            <div className="text-[10px] tracking-wider uppercase font-semibold text-[var(--text-tertiary)] mb-2">
                {t('runs.tab.what_happened', 'What happened')}
            </div>
            <ol className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5">
                <li className="contents">
                    <span className="flex flex-col items-center">
                        <Dot status="success" selected={false} />
                        {rows.length > 0 && <span className="flex-1 w-0.5 bg-[var(--border-default)]" />}
                    </span>
                    <div className="pt-px pb-4">
                        <div className="font-semibold text-[var(--text-primary)]">
                            {t('runs.timeline.started', 'Started {how}', { how: howStartedText(t, run) })}
                        </div>
                        <div className="text-[var(--text-tertiary)]">{clockTime(run.startedAt, locale, true)}</div>
                    </div>
                </li>
                {rows.map((step, i) => {
                    const selected = step.stepId === selectedStepId;
                    const result = stepResult(t, step);
                    const failed = step.status === 'error' || step.status === 'failed';
                    const last = i === rows.length - 1;
                    // Inputs, not items: one mapping that missed on 40 rows is one.
                    const misses = stepBindingWarnings(step).length;
                    return (
                        <li key={step.stepId} className="contents">
                            <span className="flex flex-col items-center">
                                <Dot status={String(step.status || '')} selected={selected} />
                                {!last && <span className="flex-1 w-0.5 bg-[var(--border-default)]" />}
                            </span>
                            <button
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onSelectStep(selected ? null : step.stepId)}
                                className={`text-left mb-3 -mt-1.5 px-2.5 py-2 rounded-lg border transition ${selected
                                    ? 'bg-[var(--bg-card)] border-[var(--border-default)] shadow-sm'
                                    : 'border-transparent hover:bg-[var(--bg-secondary)]'}`}
                            >
                                <div className="font-semibold text-[var(--text-primary)] truncate">{runStepLabel(labelById, step.stepId)}</div>
                                {result && (
                                    <div className={`mt-0.5 ${failed ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'} line-clamp-2`}>{result}</div>
                                )}
                                {misses > 0 && (
                                    <div className="mt-0.5 flex items-center gap-1 text-[var(--warning)]">
                                        <SearchX size={11} aria-hidden className="shrink-0" />
                                        <span className="truncate">
                                            {misses === 1
                                                ? t('runs.timeline.binding_misses_one', '1 mapping found nothing')
                                                : t('runs.timeline.binding_misses_many', '{n} mappings found nothing', { n: misses })}
                                        </span>
                                    </div>
                                )}
                                <div className="mt-0.5 text-[var(--text-tertiary)]">{formatSeconds(t, stepDuration(step))}</div>
                            </button>
                        </li>
                    );
                })}
            </ol>
            {!rows.length && (
                <div className="text-[var(--text-tertiary)] italic">{t('runs.tab.no_steps', 'No steps recorded for this run yet.')}</div>
            )}
            <button
                type="button"
                onClick={onViewCanvas}
                className="mt-auto pt-3 self-start flex items-center gap-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
                <Workflow size={12} aria-hidden />
                <span className="underline">{t('runs.tab.view_canvas', 'View on the canvas')}</span>
            </button>
        </div>
    );
}
