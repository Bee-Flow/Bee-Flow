import React, { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { CompareSide } from '@/api/queries/automation/runChecks';
import { useRunCompare } from '@/api/queries/automation/runChecks';
import { useRunSteps } from '@/api/queries/automation/runs';
import { buildRunStepLabelMap, runStepLabel } from '../flow/displayHelpers';
import RunCompareStep from './RunCompareStep';
import { compareErrorText } from './runChecksErrors';
import { modeText, summaryLine, verdictText } from './runCompareText';
import type { VerdictTone } from './runCompareText';
import { runTone } from './runOutcome';
import RunStatusIcon from './RunStatusIcon';

const TONE: Record<VerdictTone, string> = {
    good: 'text-[var(--success)]',
    soft: 'text-[var(--warning)]',
    bad: 'text-[var(--error)]',
};

/** One of the two runs: which one, how it ended, which version, when. */
function SideCard({ letter, side, onOpen }: { letter: 'A' | 'B'; side: CompareSide; onOpen?: (runId: string) => void }) {
    const { t, locale } = useTranslation();
    const tone = runTone({ id: side.runId, status: side.status });
    const when = side.startedAt
        ? new Date(side.startedAt).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '';
    const ended = tone === 'success' ? t('automation_run_checks.side.finished', 'Finished')
        : tone === 'error' ? t('automation_run_checks.side.stopped', 'Stopped')
            : tone === 'running' ? t('automation_run_checks.side.running', 'Still running')
                : tone === 'waiting' ? t('automation_run_checks.side.waiting', 'Waiting') : (side.status || '');
    return (
        <div className="min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
            <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <RunStatusIcon tone={tone} size={14} />
                {t('automation_run_checks.side.run_letter', 'Run {letter}', { letter })}
                <span className="font-normal text-[var(--text-secondary)]">{ended}</span>
            </div>
            <div className="mt-0.5 text-[var(--text-tertiary)]">
                {[when, side.version != null ? t('runs.tab.version_n', 'version {n}', { n: side.version }) : '', modeText(t, side.mode, side.triggerKind)].filter(Boolean).join(' · ')}
            </div>
            {onOpen && side.runId && (
                <button type="button" onClick={() => onOpen(side.runId)} className="mt-1 text-[var(--accent-primary)] hover:underline">
                    {t('automation_run_checks.side.open', 'Open run {letter}', { letter })}
                </button>
            )}
        </div>
    );
}

interface RunCompareProps {
    runId: string;
    otherRunId: string;
    onClose: () => void;
    onOpenRun?: (runId: string) => void;
    /** Fields a golden replay leaves out of its verdict; they are still listed below. */
    ignoredPaths?: string[];
}

/** Two runs of one automation, step by step: the verdict first, the differences below. */
export default function RunCompare({ runId, otherRunId, onClose, onOpenRun, ignoredPaths = [] }: RunCompareProps) {
    const { t } = useTranslation();
    const compare = useRunCompare(runId, otherRunId);
    const stepsQuery = useRunSteps(runId, true);
    const labelById = useMemo(() => buildRunStepLabelMap(stepsQuery.data?.definition ?? null), [stepsQuery.data]);
    const [onlyDifferences, setOnlyDifferences] = useState(true);
    const result = compare.data;
    const shown = (result?.steps ?? []).filter(s => !onlyDifferences || s.verdict !== 'same');
    const verdict = result ? verdictText(t, result) : null;

    return (
        <div className="h-full min-h-0 flex flex-col text-xs">
            <header className="px-5 py-3.5 flex items-center gap-2.5 border-b border-[var(--border-default)] bg-[var(--bg-card)]">
                <button type="button" onClick={onClose} aria-label={t('automation_run_checks.compare.back', 'Back to the run')} className="p-1 -ml-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                    <ArrowLeft size={16} />
                </button>
                <h2 className="font-semibold text-sm text-[var(--text-primary)]">{t('automation_run_checks.compare.title', 'Compare runs')}</h2>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
                {compare.isLoading && <p className="text-[var(--text-tertiary)]">{t('automation_run_checks.compare.loading', 'Comparing…')}</p>}
                {compare.isError && <p role="alert" className="text-[var(--error)]">{compareErrorText(compare.error, t)}</p>}
                {result && verdict && (
                    <>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <SideCard letter="A" side={result.a} onOpen={onOpenRun} />
                            <SideCard letter="B" side={result.b} onOpen={onOpenRun} />
                        </div>
                        <div role="status">
                            <div className={`text-base font-semibold ${TONE[verdict.tone]}`}>{verdict.text}</div>
                            <div className="text-[var(--text-secondary)]">{summaryLine(t, result.summary)}</div>
                        </div>
                        {ignoredPaths.length > 0 && (
                            <p className="text-[var(--text-tertiary)]">
                                {t('automation_run_checks.compare.ignored', 'The replay verdict leaves out: {fields}. They are still listed here.', { fields: ignoredPaths.join(', ') })}
                            </p>
                        )}
                        {result.truncated && (
                            <p className="text-[var(--text-tertiary)]">{t('automation_run_checks.compare.truncated', 'The comparison was cut short: not every step or file is listed.')}</p>
                        )}
                        <label className="inline-flex items-center gap-2 text-[var(--text-secondary)] self-start">
                            <input type="checkbox" checked={onlyDifferences} onChange={e => setOnlyDifferences(e.target.checked)} />
                            {t('automation_run_checks.compare.only_differences', 'Show only differences')}
                        </label>
                        {shown.length === 0 ? (
                            <p className="text-[var(--text-tertiary)]">
                                {result.steps.length === 0
                                    ? t('automation_run_checks.compare.no_steps', 'Neither run has steps to compare.')
                                    : t('automation_run_checks.compare.no_differences', 'No differences. Every step gave the same result.')}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1.5" aria-label={t('automation_run_checks.compare.steps_label', 'Steps')}>
                                {shown.map(s => (
                                    <RunCompareStep key={s.key} step={s} label={String(runStepLabel(labelById, s.stepId))} />
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
