import { Crosshair, ExternalLink, FileText, Play, X } from 'lucide-react';
import { statusVar } from './nodeTypeColors';
import { formatElapsed } from './runFocus';
import type { RunFocus } from './runFocus';
import type { RunIdentity } from './useFailedRunBanner';
import useTranslation from '../../../../hooks/useTranslation';
import { formatDate } from '../../../../utils/dateFormatters';

/**
 * The canvas's run banner (CanvasSouthBar's first precedence): a run in
 * flight, parked on a form, or failed. A failure names the run it belongs to
 * (`runIdentity`: a test run or a run, with its absolute start time) and
 * can be dismissed (`onDismissRun`).
 */
interface RunBannerProps {
    runFocus: RunFocus;
    now: number;
    ticking: boolean;
    runIdentity?: RunIdentity | null;
    onDismissRun?: (() => void) | null;
    onShowRun?: (() => void) | null;
    formUrl?: string | null;
    onOpenFormOverlay?: (() => void) | null;
}

export default function RunBanner({
    runFocus, now, ticking, runIdentity = null, onDismissRun = null,
    onShowRun = null, formUrl = null, onOpenFormOverlay = null,
}: RunBannerProps) {
    const { t, locale } = useTranslation();
    const elapsed = runFocus.startedAt ? formatElapsed(runFocus.startedAt, ticking ? now : Date.now()) : null;
    const failed = runFocus.state === 'error';
    // `runFocus.state` is already the run's status word ('running' |
    // 'error'), so the banner takes its colour from the shared status
    // table like everything else on this canvas. It used to hard-code
    // amber for a live run — the colour this product reserves for "needs
    // your attention" — and sat directly beneath cards that now pulse
    // blue for the very same run.
    const tone = statusVar(runFocus.state) || 'var(--text-tertiary)';
    const doneTone = statusVar('success') ?? 'var(--text-tertiary)';
    const total = Math.max(0, Number(runFocus.total) || 0);
    const done = Math.min(total, Math.max(0, Number(runFocus.done) || 0));
    const openRunId = runIdentity?.id || null;
    const openRun = runIdentity?.onOpen || null;
    return (
        <div
            className="flex items-center gap-3 pl-3.5 pr-2 py-2 rounded-xl bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)]"
            style={{ border: `1px solid ${tone}`, boxShadow: 'var(--shadow-popover)' }}
            data-testid="canvas-run-banner"
        >
            <span className="relative flex h-2 w-2 shrink-0">
                {!failed && <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ background: tone }} />}
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: tone, boxShadow: `0 0 0 3px color-mix(in srgb, ${tone} 30%, transparent)` }} />
            </span>
            <span className="whitespace-nowrap">
                <b>{failed ? t('automations.canvas.run_step_failed', 'Step failed') : t('automations.canvas.run_live', 'Live run')}</b>
                {runFocus.label && <span className="text-[var(--text-secondary)]"> · {runFocus.label}</span>}
                {runFocus.awaitingForm && (
                    <span className="text-[var(--text-secondary)]"> · {t('automations.canvas.run_waiting_form', 'waiting for the form')}</span>
                )}
                {total > 0 && failed && (
                    <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="canvas-run-steps-done">
                        {' · '}{total === 1
                            ? t('automations.canvas.run_steps_done_one', '{done} of {total} step completed', { done, total })
                            : t('automations.canvas.run_steps_done_other', '{done} of {total} steps completed', { done, total })}
                    </span>
                )}
                {total > 0 && !failed && <span className="text-[var(--text-tertiary)] tabular-nums"> · {done}/{total}</span>}
                {/* WHICH run: a test run or a run, and when it started in absolute
                    time — the relative age alone is easy to miss. Absent when
                    the host already names the run elsewhere. */}
                {failed && runIdentity && (
                    <span className="text-[var(--text-secondary)]" data-testid="canvas-run-identity" title={runIdentity.id || undefined}>
                        {' · '}{runIdentity.kind === 'test' ? t('automations.canvas.run_kind_test', 'Test run') : t('automations.canvas.run_kind_run', 'Run')}
                        {runIdentity.startedAt && ` ${formatDate(runIdentity.startedAt, { withTime: true, locale })}`}
                    </span>
                )}
                {/* How long this has been going. It is the reason someone
                    looks at the banner twice — "still running" and "running
                    for twelve minutes" are different facts. */}
                {elapsed && (
                    <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="canvas-run-elapsed"> · {elapsed}</span>
                )}
            </span>
            {total > 0 && (
                <span className="flex items-center gap-[3px]" aria-hidden="true" data-testid="canvas-run-progress">
                    {Array.from({ length: Math.min(total, 12) }, (_, i) => {
                        const slot = total <= 12 ? i : Math.round((i / 11) * (total - 1));
                        const state = slot < done ? 'done' : slot === done && !failed ? 'current' : slot === done && failed ? 'failed' : 'todo';
                        // 'current' and 'failed' are the same slot — where
                        // the run got to — so both wear the banner's tone.
                        const bg = state === 'done' ? doneTone
                            : (state === 'current' || state === 'failed') ? tone
                            : 'var(--bg-tertiary)';
                        return <span key={i} className="h-1.5 w-3.5 rounded-[3px]" style={{ background: bg }} />;
                    })}
                </span>
            )}
            {runFocus.stepId && onShowRun && (
                <button
                    type="button"
                    onClick={onShowRun}
                    title={t('automations.canvas_south_bar.centre_the_canvas_on_this_step', 'Centre the canvas on this step')}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-default)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <Crosshair size={12} /> {t('automations.canvas.run_show', 'Go to step')}
                </button>
            )}
            {/* The one thing that un-parks a run waiting on a form: the
                page itself. The primary action shows it over the canvas
                (the overlay, attached to this run); the public page stays
                reachable as a small secondary link. Absent when neither
                exists; never a dead control. */}
            {runFocus.awaitingForm && onOpenFormOverlay && (
                <button
                    type="button"
                    onClick={onOpenFormOverlay}
                    data-testid="canvas-run-open-form"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition hover:opacity-90 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                >
                    <FileText size={12} /> {t('automations.canvas.open_form', 'Open the form')}
                </button>
            )}
            {runFocus.awaitingForm && formUrl && (
                <a
                    href={formUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="canvas-run-open-form-tab"
                    aria-label={t('automations.canvas.open_form_new_tab', 'Open in a new tab')}
                    title={t('automations.canvas.open_form_new_tab', 'Open in a new tab')}
                    className="inline-flex items-center justify-center p-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <ExternalLink size={12} />
                </a>
            )}
            {failed && openRunId && openRun && (
                <button
                    type="button"
                    onClick={() => openRun(openRunId)}
                    data-testid="canvas-run-view"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-default)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <Play size={12} /> {t('automations.canvas.run_view', 'View run')}
                </button>
            )}
            {failed && onDismissRun && (
                <button
                    type="button"
                    onClick={onDismissRun}
                    data-testid="canvas-run-dismiss"
                    aria-label={t('automations.canvas.run_dismiss', 'Dismiss the failed-run notice')}
                    title={t('automations.canvas.run_dismiss', 'Dismiss the failed-run notice')}
                    className="inline-flex items-center justify-center p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <X size={12} />
                </button>
            )}
        </div>
    );
}
