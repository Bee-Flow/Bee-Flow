import { ArrowLeft, RotateCcw, Ban, Check, X, ExternalLink, Link2, Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { enteredTriggerLabel, errorClassLabel, runTitle, triggerLabel } from './runLanguage';
import { formatDuration, formatRelative, formatExpiry } from '../AutomationsStudio/historyUtils';
import { RunStatusBadge, DryRunBadge } from '../AutomationsStudio/RunStatusBits';

/**
 * Top bar of the full-screen execution view: back, the run's NAME (when it
 * ran — not a hex id), status, timing, trigger, lineage (retries), and the
 * contextual run actions. Every `run.*` read is guarded — the bar renders a
 * skeleton while the run loads, because it carries the only back button and
 * `return null` used to strand the user in a bare canvas.
 */
export default function ExecutionBar({ run, definition = null, onBack, onRetry, onCancel, onApprove, onOpenEditor, onOpenRun = null, showOpenEditor = true }) {
    const { t } = useTranslation();
    const [pending, setPending] = useState(null);
    const [actionError, setActionError] = useState(null);

    const isError = run?.status === 'error';
    const isRunning = run?.status === 'running' || run?.status === 'queued';
    const isAwaiting = run?.status === 'awaiting_approval' || run?.status === 'awaiting_confirm';
    const isDry = run?.mode === 'dry_run';
    const classNote = errorClassLabel(run?.errorClass, t);
    const expiry = run?.awaitingStepExpiresAt ? formatExpiry(run.awaitingStepExpiresAt) : null;

    const act = async (key, fn) => {
        if (pending || !fn) return;
        setPending(key);
        setActionError(null);
        try {
            await fn();
        } catch (e) {
            // Surface the failure — without a catch this was an unhandled
            // promise rejection and the button just silently reset.
            const message = e?.message || t('studio_misc.runbar.unknown_error', 'unknown error');
            const failed = {
                retry: () => t('studio_misc.runbar.failed_retry', 'retry failed: {message}', { message }),
                cancel: () => t('studio_misc.runbar.failed_cancel', 'cancel failed: {message}', { message }),
                approve: () => t('studio_misc.runbar.failed_approve', 'approve failed: {message}', { message }),
                reject: () => t('studio_misc.runbar.failed_reject', 'reject failed: {message}', { message }),
            }[key];
            setActionError(failed ? failed() : t('studio_misc.runbar.failed_other', '{action} failed: {message}', { action: key, message }));
        } finally {
            setPending(null);
        }
    };

    const copyLink = () => {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('view', 'runs');
            url.searchParams.set('run', run.id);
            navigator.clipboard?.writeText(url.toString());
        } catch { /* clipboard blocked */ }
    };

    return (
        // @container/runbar: under 72rem of its own width (a laptop) the two
        // secondary buttons show their icon alone, named on hover, so the
        // run's name and facts keep the row.
        <div className="@container/runbar flex-shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-primary)]">
            <button
                onClick={onBack}
                title={t('studio_misc.runbar.back_to_runs', 'Back to Runs')}
                className="inline-flex items-center gap-1 p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
            >
                <ArrowLeft size={16} /> <span className="text-xs font-medium">{t('studio_misc.runbar.runs', 'Runs')}</span>
            </button>

            {!run ? (
                // Skeleton — the back button above must exist even before the
                // run resolves (or fails to).
                <span className="text-xs text-[var(--text-tertiary)]">{t('studio_misc.runbar.loading', 'Loading the run…')}</span>
            ) : (
                <>
                    <span className="text-[var(--text-tertiary)]">·</span>
                    <span className="text-sm font-medium text-[var(--text-primary)]" title={run.id}>{runTitle(run, undefined, t)}</span>
                    <RunStatusBadge status={run.status} />
                    {isDry && <DryRunBadge />}

                    {formatDuration(run.durationMs) && (
                        <span className="text-xs text-[var(--text-secondary)] tabular-nums">{t('studio_misc.runbar.took', 'took {duration}', { duration: formatDuration(run.durationMs) })}</span>
                    )}
                    {run.startedAt && (
                        <span className="text-xs text-[var(--text-tertiary)]" title={run.startedAt}>{formatRelative(run.startedAt)}</span>
                    )}
                    {(run.triggerKind || run.automationTriggerType) && (
                        <span className="text-xs text-[var(--text-tertiary)]">· {triggerLabel(run.triggerKind || run.automationTriggerType, t)}</span>
                    )}
                    {/* The entry point, for an automation with several triggers —
                        resolved against the snapshot that ran, not today's. */}
                    {enteredTriggerLabel(run, definition) && (
                        <span className="text-xs text-[var(--text-tertiary)]" title={t('studio_misc.runbar.via_title', 'The trigger this run started from')}>{t('studio_misc.runbar.via', '· via {trigger}', { trigger: enteredTriggerLabel(run, definition) })}</span>
                    )}
                    {run.version != null && (
                        <span className="text-[10px] text-[var(--text-tertiary)] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)]" title={t('studio_misc.runbar.version_title', 'This run used saved version {version}.', { version: run.version })}>v{run.version}</span>
                    )}
                    {/* Lineage: a retry names — and opens — the run it replays.
                        A run that CONTINUES a paused one also carries a
                        parentRunId, but it is the same journey (same rootRunId)
                        and shows as a single row — calling that "a retry" was
                        simply wrong. A real retry starts its own journey, so
                        its root is itself. */}
                    {run.parentRunId && run.rootRunId === run.id && (
                        <button
                            type="button"
                            onClick={() => onOpenRun?.(run.parentRunId)}
                            disabled={!onOpenRun}
                            className="text-[10px] text-[var(--text-secondary)] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition disabled:cursor-default"
                            title={t('studio_misc.runbar.open_earlier', 'Open the earlier run')}
                        >
                            {t('studio_misc.runbar.was_retry', 'This was a retry of an earlier run')}
                        </button>
                    )}
                    {Number(run.handledErrorCount || 0) > 0 && (
                        <span className="text-[10px] text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10">
                            {run.handledErrorCount === 1
                                ? t('studio_misc.runbar.handled_one', '1 problem handled automatically')
                                : t('studio_misc.runbar.handled_many', '{n} problems handled automatically', { n: run.handledErrorCount })}
                        </span>
                    )}
                    {isAwaiting && expiry && (
                        <span className="text-[10px] text-amber-700 dark:text-amber-300">{expiry}</span>
                    )}
                    {isError && classNote && (
                        <span className="text-[10px] text-red-600 dark:text-red-400">({classNote})</span>
                    )}

                    <div className="ml-auto flex items-center gap-2">
                        {isError && onRetry && (
                            <BarButton onClick={() => act('retry', onRetry)} pending={pending === 'retry'} icon={<RotateCcw size={14} />} tone="primary" title={t('studio_misc.runbar.run_again_title', 'Uses the automation as it is now')}>
                                {t('studio_misc.runbar.run_again', 'Run it again')}
                            </BarButton>
                        )}
                        {isRunning && onCancel && (
                            <BarButton onClick={() => act('cancel', onCancel)} pending={pending === 'cancel'} icon={<Ban size={14} />} tone="danger">{t('studio_misc.runbar.stop', 'Stop it')}</BarButton>
                        )}
                        {/* Step-level approvals (awaiting_approval) decide in
                            the panel below the bar — it shows the question,
                            collects answers, and requires a reason to reject
                            (which the server now enforces; the bar's naked
                            buttons couldn't carry one). The RUN-level first-run
                            confirm needs no reason and no answers, so both of
                            its answers stay here, one click each: Approve
                            promotes the automation to live, Reject closes this run
                            and leaves the gate on for next time. Each button
                            hands its own word to onApprove — the view acts on
                            the word rather than assuming approval. */}
                        {run?.status === 'awaiting_confirm' && (
                            <>
                                <BarButton onClick={() => act('approve', () => onApprove?.('approve'))} pending={pending === 'approve'} icon={<Check size={14} />} tone="primary">{t('studio_misc.runbar.approve', 'Approve')}</BarButton>
                                <BarButton onClick={() => act('reject', () => onApprove?.('reject'))} pending={pending === 'reject'} icon={<X size={14} />} tone="danger">{t('studio_misc.runbar.reject', 'Reject')}</BarButton>
                            </>
                        )}
                        <button
                            onClick={copyLink}
                            aria-label={t('studio_misc.runbar.copy_link', 'Copy link')}
                            className={SECONDARY}
                            title={t('studio_misc.runbar.copy_link_title', 'Copy a link to this run')}
                        >
                            <Link2 size={14} aria-hidden /> <span className="hidden @[72rem]/runbar:inline">{t('studio_misc.runbar.copy_link', 'Copy link')}</span>
                        </button>
                        {showOpenEditor && (
                            <button
                                onClick={() => run.automationId && onOpenEditor?.(run.automationId)}
                                disabled={!run.automationId}
                                aria-label={t('studio_misc.runbar.open_editor', 'Open in editor')}
                                title={t('studio_misc.runbar.open_editor', 'Open in editor')}
                                className={`${SECONDARY} disabled:opacity-50`}
                            >
                                <ExternalLink size={14} aria-hidden /> <span className="hidden @[72rem]/runbar:inline">{t('studio_misc.runbar.open_editor', 'Open in editor')}</span>
                            </button>
                        )}
                    </div>
                </>
            )}
            {actionError && (
                <div className="w-full mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{actionError}</div>
            )}
        </div>
    );
}

const SECONDARY = 'inline-flex items-center gap-1.5 text-xs font-medium px-2 @[72rem]/runbar:px-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition';

function BarButton({ onClick, pending, icon, tone, title = undefined, children }) {
    const toneCls = tone === 'danger'
        ? 'border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10'
        : 'text-[var(--accent-primary-fg,#ffffff)] border-transparent';
    const toneStyle = tone === 'primary' ? { background: 'var(--accent-primary, var(--text-primary))' } : undefined;
    return (
        <button
            onClick={onClick}
            disabled={pending}
            style={toneStyle}
            title={title}
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition disabled:opacity-50 ${toneCls}`}
        >
            {pending ? <Loader2 size={14} className="animate-spin" /> : icon}
            {children}
        </button>
    );
}
