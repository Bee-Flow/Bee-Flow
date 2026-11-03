import { useState } from 'react';
import { Crosshair, ExternalLink, FileText, History, Pause, Play, RotateCcw, ShieldQuestion, Square, X } from 'lucide-react';
import { statusVar } from './nodeTypeColors';
import { formatElapsed } from './runFocus';
import type { RunFocus } from './runFocus';
import { bannerElapsedEnd, bannerTitle, isParked, type RunPause } from './runPause';
import type { RunIdentity } from './useFailedRunBanner';
import useTranslation from '@/hooks/useTranslation';
import { formatDate } from '@/utils/dateFormatters';

/**
 * The canvas's run banner (CanvasSouthBar): a run in flight, waiting (on a
 * form page or a decision), or failed. A failure names the run it belongs to
 * (`runIdentity`: a test run or a run, with its absolute start time) and can
 * be dismissed (`onDismissRun`).
 *
 * A waiting run says WHOSE wait it is (`runIdentity.pause`, flow/runPause.ts):
 * "Waiting for your decision (test)" with Review & decide, "Waiting for the
 * form" with Open the form, "A visitor is on …" with View run for a real
 * visitor's journey. A waiting TEST can be stopped (a dry run discarded), and
 * one that started on a version the working copy has moved past says so,
 * with a way to restart it on the current one. Its clock stands still at the
 * moment it paused.
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

const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-default)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition';
const PRIMARY_BUTTON = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition hover:opacity-90 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';

export default function RunBanner({
    runFocus, now, ticking, runIdentity = null, onDismissRun = null,
    onShowRun = null, formUrl = null, onOpenFormOverlay = null,
}: RunBannerProps) {
    const { t, locale } = useTranslation();
    const end = bannerElapsedEnd(runFocus, now, ticking);
    const elapsed = runFocus.startedAt && end != null ? formatElapsed(runFocus.startedAt, end) : null;
    const failed = runFocus.state === 'error';
    const parked = isParked(runFocus);
    const pause = runIdentity?.pause ?? null;
    // A visitor's form page names its page in the title already.
    const visitorPage = runFocus.awaitingForm && !!pause && !pause.isTest;
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
    return (
        <div
            className="flex flex-col gap-1.5 pl-3.5 pr-2 py-2 rounded-xl bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)]"
            style={{ border: `1px solid ${tone}`, boxShadow: 'var(--shadow-popover)' }}
            data-testid="canvas-run-banner"
            data-paused={parked ? '' : undefined}
        >
            <div className="flex items-center gap-3">
                <span className="relative flex h-2 w-2 shrink-0">
                    {!failed && !parked && <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ background: tone }} />}
                    <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: tone, boxShadow: `0 0 0 3px color-mix(in srgb, ${tone} 30%, transparent)` }} />
                </span>
                <span className="whitespace-nowrap">
                    <b data-testid="canvas-run-title">{bannerTitle(runFocus, pause, t)}</b>
                    {runFocus.label && !visitorPage && <span className="text-[var(--text-secondary)]"> · {runFocus.label}</span>}
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
                        for twelve minutes" are different facts. A waiting run's
                        clock stopped when it paused. */}
                    {elapsed && (
                        <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="canvas-run-elapsed">
                            {' · '}{parked && <Pause size={10} className="inline -mt-px mr-0.5" aria-hidden="true" />}{elapsed}
                        </span>
                    )}
                </span>
                {total > 0 && <ProgressSlots total={total} done={done} failed={failed} tone={tone} doneTone={doneTone} />}
                {runFocus.stepId && onShowRun && (
                    <button
                        type="button"
                        onClick={onShowRun}
                        title={t('automations.canvas_south_bar.centre_the_canvas_on_this_step', 'Centre the canvas on this step')}
                        className={SECONDARY_BUTTON}
                    >
                        <Crosshair size={12} /> {t('automations.canvas.run_show', 'Go to step')}
                    </button>
                )}
                <PauseActions runFocus={runFocus} runIdentity={runIdentity} formUrl={formUrl} onOpenFormOverlay={onOpenFormOverlay} />
                {failed && <FailureActions runIdentity={runIdentity} onDismissRun={onDismissRun} />}
            </div>
            {parked && pause?.isTest && pause.versionBehind && <VersionBehindNotice runId={runIdentity?.id ?? null} pause={pause} />}
        </div>
    );
}

/** Where the run got to, one slot per step (at most twelve). */
function ProgressSlots({ total, done, failed, tone, doneTone }: { total: number; done: number; failed: boolean; tone: string; doneTone: string }) {
    return (
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
    );
}

interface PauseActionsProps {
    runFocus: RunFocus;
    runIdentity: RunIdentity | null;
    formUrl: string | null;
    onOpenFormOverlay: (() => void) | null;
}

/**
 * What a waiting run offers. Never a dead control: each action is drawn only
 * when the host wired it, and only for the wait it belongs to.
 */
function PauseActions({ runFocus, runIdentity, formUrl, onOpenFormOverlay }: PauseActionsProps) {
    const pause = runIdentity?.pause ?? null;
    if (!isParked(runFocus)) return null;
    return (
        <>
            {runFocus.awaitingApproval && <ReviewButton stepId={runFocus.stepId} pause={pause} />}
            {runFocus.awaitingForm && <FormActions runIdentity={runIdentity} formUrl={formUrl} onOpenFormOverlay={onOpenFormOverlay} />}
            {pause?.isTest && pause.onStop && <StopButton pause={pause} onStop={pause.onStop} />}
        </>
    );
}

/** "Review & decide": the waiting step's drawer, where the decision is made. Not for somebody who cannot decide it. */
function ReviewButton({ stepId, pause }: { stepId: string | null; pause: RunPause | null }) {
    const { t } = useTranslation();
    const review = pause?.onReview;
    if (!stepId || !review || pause.canDecide === false) return null;
    return (
        <button type="button" onClick={() => review(stepId)} data-testid="canvas-run-review" className={PRIMARY_BUTTON}>
            <ShieldQuestion size={12} /> {t('automations.canvas.run_review_decide', 'Review & decide')}
        </button>
    );
}

/**
 * A form wait. The one thing that un-parks a test waiting on a form is the
 * page itself, shown over the canvas (the overlay, attached to this run): the
 * host offers it only for a test run of its own. A visitor's page is theirs;
 * the run is what the owner can look at.
 */
function FormActions({ runIdentity, formUrl, onOpenFormOverlay }: Omit<PauseActionsProps, 'runFocus'>) {
    const { t } = useTranslation();
    const pause = runIdentity?.pause ?? null;
    const runId = runIdentity?.id || null;
    const openRun = pause && !pause.isTest && runId ? runIdentity?.onOpen : null;
    return (
        <>
            {onOpenFormOverlay && (
                <button type="button" onClick={onOpenFormOverlay} data-testid="canvas-run-open-form" className={PRIMARY_BUTTON}>
                    <FileText size={12} /> {t('automations.canvas.open_form', 'Open the form')}
                </button>
            )}
            {formUrl && (
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
            {openRun && runId && (
                <button type="button" onClick={() => openRun(runId)} data-testid="canvas-run-view" className={SECONDARY_BUTTON}>
                    <Play size={12} /> {t('automations.canvas.run_view', 'View run')}
                </button>
            )}
        </>
    );
}

/** "Stop this test", or "Discard" for a dry run: nothing real happened in it. */
function StopButton({ pause, onStop }: { pause: RunPause; onStop: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={onStop} data-testid="canvas-run-stop" className={SECONDARY_BUTTON}>
            <Square size={11} />{' '}
            {pause.isDry ? t('automations.canvas.run_discard', 'Discard') : t('automations.canvas.run_stop_test', 'Stop this test')}
        </button>
    );
}

/** A failure: open its run, or dismiss the notice. */
function FailureActions({ runIdentity, onDismissRun }: { runIdentity: RunIdentity | null; onDismissRun: (() => void) | null }) {
    const { t } = useTranslation();
    const openRunId = runIdentity?.id || null;
    const openRun = runIdentity?.onOpen || null;
    return (
        <>
            {openRunId && openRun && (
                <button type="button" onClick={() => openRun(openRunId)} data-testid="canvas-run-view" className={SECONDARY_BUTTON}>
                    <Play size={12} /> {t('automations.canvas.run_view', 'View run')}
                </button>
            )}
            {onDismissRun && (
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
        </>
    );
}

/**
 * A waiting test of an older version (tests-and-docs F9): what continues is
 * what it started on, not the canvas. Continue keeps it (and hides this for
 * that run); Restart runs the current version again with this run's answers.
 */
function VersionBehindNotice({ runId, pause }: { runId: string | null; pause: RunPause }) {
    const { t } = useTranslation();
    const [keptFor, setKeptFor] = useState<string | null>(null);
    if (runId && keptFor === runId) return null;
    return (
        <div className="flex items-center gap-2 border-t border-[var(--border-default)] pt-1.5 text-[var(--text-secondary)]" data-testid="canvas-run-version-behind">
            <History size={12} className="shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">{t('automations.canvas.run_version_behind', 'This test started on an older version')}</span>
            <button type="button" onClick={() => setKeptFor(runId)} data-testid="canvas-run-keep-version" className={SECONDARY_BUTTON}>
                {t('automations.canvas.run_keep_version', 'Continue on the old version')}
            </button>
            {pause.onRestart && (
                <button type="button" onClick={pause.onRestart} data-testid="canvas-run-restart" className={PRIMARY_BUTTON}>
                    <RotateCcw size={12} /> {t('automations.canvas.run_restart_current', 'Restart with the current version')}
                </button>
            )}
        </div>
    );
}

/**
 * A waiting run while the selection or build bar holds the south edge: one
 * small pill beside it, that takes the camera to the waiting step.
 */
export function RunChip({ runFocus, runIdentity = null, onShowRun = null }: { runFocus: RunFocus; runIdentity?: RunIdentity | null; onShowRun?: (() => void) | null }) {
    const { t } = useTranslation();
    const title = bannerTitle(runFocus, runIdentity?.pause ?? null, t);
    return (
        <button
            type="button"
            onClick={onShowRun ?? undefined}
            disabled={!onShowRun}
            title={runFocus.label || undefined}
            data-testid="canvas-run-chip"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] [box-shadow:var(--shadow-popover)] hover:text-[var(--text-primary)] disabled:cursor-default transition whitespace-nowrap"
        >
            <Pause size={10} aria-hidden="true" /> {title}
        </button>
    );
}
