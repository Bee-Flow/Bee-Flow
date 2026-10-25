import React, { useState } from 'react';
import { ArrowLeft, Link as LinkIcon, PenLine, RotateCcw } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { RunRowData } from '../../../../api/queries/automation/runs';
import { retriedRunId, useRetryRun } from '../../../../api/queries/automation/runs';
import { toast } from '../../../shared/Toast';
import { runMeta, runSentence, runTone } from './runOutcome';
import RunStatusIcon from './RunStatusIcon';
import RunAction from './RunAction';
import GoldenControl from './GoldenControl';
import CompareWithMenu from './CompareWithMenu';

/** The link that reopens this run in the builder's Runs tab. */
function runLink(runId: string, href: string = window.location.href): string {
    const url = new URL(href);
    url.searchParams.set('view', 'runs');
    url.searchParams.set('run', runId);
    url.searchParams.delete('step');
    return url.toString();
}

interface RunDetailHeaderProps {
    automationId: string;
    run: RunRowData;
    onOpenRun: (runId: string) => void;
    onOpenEditor?: (stepId?: string | null) => void;
    onClose: () => void;
    /** Open the compare view for this run and another one. */
    onCompare?: (otherRunId: string) => void;
    /** The run's data is hidden from this viewer: no golden, no compare. */
    dataHidden?: boolean;
}

/** The run in one sentence, how it came about, and the next moves. */
export default function RunDetailHeader({ automationId, run, onOpenRun, onOpenEditor, onClose, onCompare, dataHidden = false }: RunDetailHeaderProps) {
    const { t, locale } = useTranslation();
    const retry = useRetryRun(automationId);
    const [retrying, setRetrying] = useState(false);
    const tone = runTone(run);
    const finished = tone !== 'running' && tone !== 'waiting';

    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(runLink(run.id));
            toast.success(t('runs.tab.link_copied', 'Link copied.'));
        } catch {
            toast.error(t('runs.tab.link_copy_failed', 'Could not copy the link.'));
        }
    };
    const runAgain = async () => {
        setRetrying(true);
        try {
            const next = retriedRunId(await retry.mutateAsync(run.id));
            if (next) onOpenRun(next);
            else toast.info(t('runs.tab.retry_pending', 'Started again. It shows up in the list in a moment.'));
        } catch {
            toast.error(t('runs.tab.retry_failed', 'Could not start the run again.'));
        } finally {
            setRetrying(false);
        }
    };

    return (
        <header className="px-5 py-3.5 flex items-center gap-2.5 border-b border-[var(--border-default)] bg-[var(--bg-card)]">
            <button type="button" onClick={onClose} aria-label={t('runs.tab.back', 'Back to the runs')} className="@[960px]/runs:hidden p-1 -ml-1 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                <ArrowLeft size={16} />
            </button>
            <RunStatusIcon tone={tone} size={18} />
            <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-sm text-[var(--text-primary)] truncate">{runSentence(t, run)}</h2>
                <div className="text-[var(--text-tertiary)] truncate">{runMeta(t, run, locale)}</div>
            </div>
            <div className="flex gap-1.5 shrink-0">
                {finished && !dataHidden && onCompare && <CompareWithMenu automationId={automationId} run={run} onCompare={onCompare} />}
                {finished && !dataHidden && <GoldenControl automationId={automationId} run={run} />}
                <RunAction icon={LinkIcon} label={t('runs.tab.copy_link', 'Copy link')} onClick={copyLink} />
                <RunAction icon={RotateCcw} label={t('runs.tab.run_again', 'Run again with this input')} onClick={runAgain} disabled={!finished || retrying} />
                <RunAction icon={PenLine} label={t('runs.tab.open_editor', 'Open in editor')} onClick={() => onOpenEditor?.(null)} />
            </div>
        </header>
    );
}
