import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { RunRowData } from '../../../../api/queries/automation/runs';
import {
    clockTime, formatSeconds, formatWaited, howStartedText, runSentence, runSubject, runTone, stepBars, stepsText,
} from './runOutcome';
import RunStatusIcon, { StepBars } from './RunStatusIcon';

interface RunRowProps {
    run: RunRowData;
    selected: boolean;
    first: boolean;
    onOpen: (runId: string) => void;
    onFix: (run: RunRowData) => void;
    onRetry: (run: RunRowData) => void;
    onRemind: (run: RunRowData) => void;
    busy?: boolean;
}

const LINK = 'underline hover:text-[var(--text-primary)] disabled:opacity-50';

/** One run in the list: what it did in a sentence, and what you can do next. */
export default function RunRow({ run, selected, first, onOpen, onFix, onRetry, onRemind, busy = false }: RunRowProps) {
    const { t, locale } = useTranslation();
    const tone = runTone(run);
    const sentence = runSentence(t, run);
    const steps = stepsText(t, run);
    const isTest = !!run.isTest || run.mode === 'dry_run';

    // Facts may truncate; the next moves never do, so a long file name cannot
    // push "Fix" or "send reminder" out of the row.
    let facts: string[];
    let actions: React.ReactNode[] = [];
    if (tone === 'error') {
        facts = [runSubject(run) || steps];
        actions = [
            <button key="fix" type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); onFix(run); }} className={`${LINK} font-semibold text-[var(--text-primary)]`}>
                {t('runs.tab.fix', 'Fix')}
            </button>,
            <button key="retry" type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); onRetry(run); }} className={LINK}>
                {t('runs.tab.try_again', 'try again')}
            </button>,
        ];
    } else if (tone === 'waiting') {
        facts = [steps, t('runs.tab.waited', 'already {time}', { time: formatWaited(t, run.startedAt) })];
        if (run.status === 'awaiting_approval') {
            actions = [
                <button key="remind" type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); onRemind(run); }} className={LINK}>
                    {t('runs.tab.send_reminder', 'send reminder')}
                </button>,
            ];
        }
    } else {
        facts = [steps, formatSeconds(t, run.durationMs), howStartedText(t, run)];
    }
    const factText = facts.filter(Boolean).join(' · ');

    return (
        <div
            role="listitem"
            data-run-id={run.id}
            aria-current={selected || undefined}
            onClick={() => onOpen(run.id)}
            className={`px-4 py-2.5 grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-1 cursor-pointer text-xs ${
                first ? '' : 'border-t border-[var(--border-default)]'
            } ${selected
                ? 'bg-[color-mix(in_srgb,var(--type-ai)_7%,transparent)] shadow-[inset_3px_0_0_var(--accent-primary)]'
                : 'hover:bg-[var(--bg-secondary)]'}`}
        >
            <span className="mt-px"><RunStatusIcon tone={tone} /></span>
            <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(run.id); }} className="min-w-0 text-left font-semibold text-[var(--text-primary)] truncate" title={sentence}>
                {sentence}
            </button>
            <span className="text-[var(--text-tertiary)] tabular-nums">{clockTime(run.startedAt, locale)}</span>
            <span />
            <div className="min-w-0 flex items-center gap-2 text-[var(--text-secondary)]">
                <StepBars statuses={stepBars(run)} />
                <span className="min-w-0 flex items-center">
                    <span className="min-w-0 truncate" title={factText}>{factText}</span>
                    {actions.length > 0 && (
                        <span className="shrink-0 whitespace-nowrap">
                            {actions.map((a, i) => (
                                // Separators sit between parts whose identity is their position.
                                <React.Fragment key={i}>{(i > 0 || factText) && '\u00a0· '}{a}</React.Fragment>
                            ))}
                        </span>
                    )}
                </span>
                {isTest && (
                    <span className="px-1.5 rounded-full bg-[var(--bg-tertiary)] text-[10px] font-semibold shrink-0">
                        {t('runs.tab.test_chip', 'test')}
                    </span>
                )}
            </div>
            <span className="text-[var(--text-tertiary)]">{run.version != null ? `v${run.version}` : ''}</span>
        </div>
    );
}
