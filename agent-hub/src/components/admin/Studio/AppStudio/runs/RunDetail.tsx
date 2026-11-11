import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { RunsApi, RunStep, RunSummary } from './runsApi';
import { useCancelRun, useRunDetail } from './runsApi';
import toast from '@/components/shared/Toast';
import RunStartedByLine from './RunStartedByLine';
import { TONE_CLASS, actorText, formatCost, formatDuration, formatTokens, originText, statusText, statusTone, stepLabel } from './runsModel';

/**
 * One run of the run log: who, when, how long, how it ended, and every step it reached with its
 * duration, error (with code), attempts, and per AI step the model, tier, tokens and cost.
 * Nothing the steps read or wrote is kept, so nothing of it is shown.
 */
export default function RunDetail({ api, appId, runId, onBack, onOpenLogic }: {
    api: RunsApi; appId: string; runId: string; onBack: () => void; onOpenLogic?: (actionId: string) => void;
}) {
    const { t, locale } = useTranslation();
    const q = useRunDetail(api, appId, runId);
    if (q.isLoading) return <p className="p-4 text-sm text-[var(--text-secondary)]">{t('studio_apps_runs.loading', 'Loading runs…')}</p>;
    if (q.isError || !q.data) {
        return (
            <div className="p-4 text-sm">
                <p className="text-[var(--error)]" role="alert">{t('studio_apps_runs.detail.load_failed', 'This run could not be loaded.')}</p>
                <button type="button" className="mt-2 text-[var(--accent-primary)]" onClick={onBack}>{t('studio_apps_runs.detail.back', 'Back to all runs')}</button>
            </div>
        );
    }
    const { run, steps, startedBy } = q.data;
    const tone = statusTone(run.status);
    return (
        <div className="flex flex-col gap-3 p-4 text-sm" data-testid="run-detail">
            <div className="flex items-center gap-3">
                <button type="button" className="text-[var(--accent-primary)]" onClick={onBack}>{t('studio_apps_runs.detail.back', 'Back to all runs')}</button>
                {onOpenLogic ? (
                    <button type="button" className="text-[var(--accent-primary)]" onClick={() => onOpenLogic(run.actionId)}>{t('studio_apps_runs.detail.open_logic', 'Open the action in Logic')}</button>
                ) : null}
                <CancelRunButton api={api} appId={appId} run={run} />
            </div>
            <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{run.actionId}</h3>
                <span className={TONE_CLASS[tone]} data-testid="run-detail-status">{statusText(run.status, t)}</span>
                <span className="text-[var(--text-secondary)]">{actorText(run.actor, t)} · {originText(run.origin, t)}</span>
                <span className="text-[var(--text-secondary)]">{run.startedAt ? new Date(run.startedAt).toLocaleString(locale) : '—'}</span>
                <span className="text-[var(--text-secondary)]" data-testid="run-detail-duration">{formatDuration(run.durationMs)}</span>
            </header>
            {startedBy ? <RunStartedByLine startedBy={startedBy} /> : null}
            {run.error ? (
                <p className="text-[var(--error)]" data-testid="run-detail-error">
                    {run.error}{run.errorCode ? ` (${run.errorCode})` : ''}{run.errorStep?.path ? ` · ${run.errorStep.path}` : ''}
                </p>
            ) : null}
            {run.ai.calls ? (
                <p className="text-[var(--text-secondary)]">
                    {t('studio_apps_runs.detail.ai_total', '{calls} AI call(s), {tokens} tokens, {cost} (estimate)', {
                        calls: run.ai.calls, tokens: formatTokens(run.ai.promptTokens + run.ai.completionTokens), cost: formatCost(run.ai.costByCurrency, locale),
                    })}
                </p>
            ) : null}
            {run.truncated ? <p className="text-[var(--text-tertiary)]">{t('studio_apps_runs.detail.truncated', 'This run had more steps than the log keeps; the first ones are shown.')}</p> : null}
            <ol className="flex flex-col divide-y divide-[var(--border-subtle)] rounded border border-[var(--border-default)]" data-testid="run-steps">
                {steps.map((s) => <StepRow key={s.seq} step={s} />)}
                {!steps.length ? <li className="p-3 text-[var(--text-tertiary)]">{t('studio_apps_runs.detail.no_steps', 'No server step was recorded for this run.')}</li> : null}
            </ol>
        </div>
    );
}

/**
 * Stops a server run that is still going or on hold (a browser run ends with its page): a running
 * one before its next step, one on hold at once. The run log is read again after.
 */
function CancelRunButton({ api, appId, run }: { api: RunsApi; appId: string; run: RunSummary }) {
    const { t } = useTranslation();
    const cancel = useCancelRun(api, appId);
    if (!api.cancel || (run.origin !== 'background' && run.origin !== 'trigger') || (run.status !== 'running' && run.status !== 'paused')) return null;
    const cancelRun = () => cancel.mutate(run.id, {
        onSuccess: (out) => toast.info(out.status === 'running'
            ? t('studio_apps_durable.runs.cancelling', 'The run stops before its next step.')
            : t('studio_apps_durable.runs.cancelled', 'The run was cancelled.')),
        onError: () => toast.error(t('studio_apps_durable.runs.cancel_failed', 'The run could not be cancelled. Try again.')),
    });
    return (
        <button type="button" className="text-[var(--error)]" disabled={cancel.isPending} onClick={cancelRun} data-testid="run-cancel">{t('studio_apps_durable.runs.cancel', 'Cancel run')}</button>
    );
}

function StepRow({ step }: { step: RunStep }) {
    const { t, locale } = useTranslation();
    const tone = statusTone(step.status);
    return (
        <li className="flex flex-col gap-1 p-3" data-testid="run-step">
            <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-xs text-[var(--text-primary)]">{stepLabel(step, t)}</span>
                <span className={TONE_CLASS[tone]}>{statusText(step.status, t)}</span>
                <span className="text-[var(--text-secondary)]" data-testid="run-step-duration">{formatDuration(step.durationMs)}</span>
                {step.attempts ? <span className="text-[var(--text-tertiary)]">{t('studio_apps_runs.step.attempts', '{n} attempts', { n: step.attempts })}</span> : null}
                {step.handled ? <span className="text-[var(--text-tertiary)]">{t('studio_apps_runs.step.handled', 'handled by onError')}</span> : null}
                {step.mocked ? <span className="text-[var(--text-tertiary)]">{t('studio_apps_runs.step.mocked', 'mocked')}</span> : null}
            </div>
            {step.error ? <p className="text-[var(--error)]" data-testid="run-step-error">{step.error}{step.errorCode ? ` (${step.errorCode})` : ''}</p> : null}
            {step.ai ? (
                <p className="text-[var(--text-secondary)]" data-testid="run-step-ai">
                    {[step.ai.model, step.ai.tier].filter(Boolean).join(' · ')}
                    {' · '}
                    {t('studio_apps_runs.step.tokens', '{in} in / {out} out tokens', { in: formatTokens(step.ai.promptTokens), out: formatTokens(step.ai.completionTokens) })}
                    {step.ai.cost !== null && step.ai.currency ? ` · ${formatCost({ [step.ai.currency]: step.ai.cost }, locale)}` : ''}
                </p>
            ) : null}
        </li>
    );
}
