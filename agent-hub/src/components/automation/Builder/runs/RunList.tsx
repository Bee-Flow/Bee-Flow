import React, { useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RunRowData } from '../../../../api/queries/automation/runs';
import { RunsRequestError, retriedRunId, useFindFailedStep, useRemindApproval, useRetryRun } from '../../../../api/queries/automation/runs';
import { toast } from '../../../shared/Toast';
import { groupRunsByDay } from './runOutcome';
import RunRow from './RunRow';

/** Say why a reminder did not go out. */
function remindRefused(t: TranslateFn, e: unknown) {
    const code = e instanceof RunsRequestError ? e.code : null;
    if (code === 'remind_rate_limited') toast.info(t('runs.tab.reminder_too_soon', 'A reminder went out less than 10 minutes ago.'));
    else if (code === 'approval_not_pending') toast.info(t('runs.tab.reminder_not_pending', 'Someone already decided this approval.'));
    else toast.error(t('runs.tab.reminder_failed', 'Could not send a reminder.'));
}

interface RunListProps {
    automationId: string;
    runs: RunRowData[];
    loading: boolean;
    failed: boolean;
    selectedRunId: string | null;
    onOpenRun: (runId: string) => void;
    onOpenEditor?: (stepId?: string | null) => void;
}

/** The runs, one group per day, each row with its own next move. */
export default function RunList({
    automationId, runs, loading, failed, selectedRunId, onOpenRun, onOpenEditor,
}: RunListProps) {
    const { t, locale } = useTranslation();
    const groups = useMemo(() => groupRunsByDay(t, runs, locale), [t, runs, locale]);
    const retry = useRetryRun(automationId);
    const remind = useRemindApproval();
    const [busyId, setBusyId] = useState<string | null>(null);
    const findFailedStep = useFindFailedStep();

    // Fix = the Editor, with the drawer open on the step that stopped the run.
    const onFix = async (run: RunRowData) => {
        setBusyId(run.id);
        const stepId = await findFailedStep(run);
        setBusyId(null);
        onOpenEditor?.(stepId);
    };

    const onRetry = async (run: RunRowData) => {
        setBusyId(run.id);
        try {
            const res = await retry.mutateAsync(run.id);
            const next = retriedRunId(res);
            if (next) onOpenRun(next);
            else toast.info(t('runs.tab.retry_pending', 'Started again. It shows up in the list in a moment.'));
        } catch {
            toast.error(t('runs.tab.retry_failed', 'Could not start the run again.'));
        } finally {
            setBusyId(null);
        }
    };
    const onRemind = async (run: RunRowData) => {
        setBusyId(run.id);
        try {
            await remind.mutateAsync(run);
            toast.success(t('runs.tab.reminder_sent', 'Reminder sent.'));
        } catch (e) {
            remindRefused(t, e);
        } finally {
            setBusyId(null);
        }
    };

    if (loading) {
        return <div className="px-4 py-6 text-xs text-[var(--text-tertiary)]">{t('runs.tab.loading', 'Loading runs…')}</div>;
    }
    if (failed) {
        return <div className="px-4 py-6 text-xs text-[var(--error)]">{t('runs.tab.load_failed', 'Could not read the runs.')}</div>;
    }
    if (!runs.length) {
        return (
            <div className="px-4 py-8 text-center text-xs text-[var(--text-secondary)]">
                {t('runs.tab.empty', 'No runs match these filters.')}
            </div>
        );
    }

    return (
        <div role="list" aria-label={t('runs.tab.list_label', 'Runs')} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            {groups.map((g, gi) => (
                <div key={g.key} role="presentation">
                    <div
                        role="presentation"
                        className={`px-4 pt-2 pb-1 text-[10px] tracking-wider uppercase font-semibold text-[var(--text-tertiary)] ${gi > 0 ? 'border-t border-[var(--border-default)]' : ''}`}
                    >
                        {g.label}
                    </div>
                    {g.runs.map((run, i) => (
                        <RunRow
                            key={run.id}
                            run={run}
                            first={i === 0}
                            selected={run.id === selectedRunId}
                            busy={busyId === run.id}
                            onOpen={onOpenRun}
                            onFix={onFix}
                            onRetry={onRetry}
                            onRemind={onRemind}
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}
