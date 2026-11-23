/**
 * "Try it first": the try-out of a plan, inside the plan card. One button runs the plan once on the owner's real
 * data; what only reads runs for real, and everything that would change or send something is held back. The list
 * shows each step as it goes, with what it got or what it WOULD have changed or sent.
 *
 * Presentation only: the try-out comes in as props (./CoworkPlanPanel.tsx starts it and follows it).
 */
import { Check, CircleDashed, FlaskConical, Loader2, Minus, ShieldCheck, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { shortDuration, tryIsRunning, tryToneOf, tryTotals } from './coworkPlanTryModel';
import type { TryTone } from './coworkPlanTryModel';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { PlanEffect, PlanTryState, PlanTryStep } from '../../api/coworkPlan.types';

export interface CoworkPlanTryProps {
    t: TranslateFn;
    /** The try-out so far; null before one was started. */
    state: PlanTryState | null;
    /** The request that starts a try-out is on its way. */
    starting?: boolean;
    /** The plan changed since this try-out, so it no longer shows the plan on screen. */
    stale?: boolean;
    /** The sentence of a refused or failed request. */
    error?: string | null;
    onStart: () => void;
}

const TONE_ICON: Record<TryTone, LucideIcon> = { pending: CircleDashed, running: Loader2, ok: Check, held: ShieldCheck, failed: X, skipped: Minus };

const TONE_INK: Record<TryTone, string> = {
    pending: 'text-[var(--text-tertiary)]',
    running: 'text-[var(--type-ai)]',
    ok: 'text-[var(--success-ink)]',
    held: 'text-[var(--warning-ink)]',
    failed: 'text-[var(--error-ink)]',
    skipped: 'text-[var(--text-tertiary)]',
};

const TONE_FALLBACK: Record<TryTone, string> = { pending: 'Waiting', running: 'Running', ok: 'Done', held: 'Held back', failed: 'Failed', skipped: 'Not reached' };
const PREVIEW_FALLBACK: Record<PlanEffect, string> = { reads: 'What it got', writes: 'What it would have changed', sends: 'What it would have sent' };

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const PILL = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px]';
const SECONDARY = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

/** What a step got, or what it would have changed or sent: folded away until asked for. */
function Preview({ step, t }: { step: PlanTryStep; t: TranslateFn }) {
    if (!step.preview) return null;
    return (
        <details className="group">
            <summary className="cursor-pointer text-[11.5px] text-[var(--text-secondary)] marker:text-[var(--text-tertiary)]">
                {t(`cowork_plan.try.preview.${step.effect}`, PREVIEW_FALLBACK[step.effect])}
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md px-2.5 py-2 text-[11.5px] leading-[1.45] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                {step.preview}
            </pre>
        </details>
    );
}

function TryStepRow({ step, t }: { step: PlanTryStep; t: TranslateFn }) {
    const tone = tryToneOf(step);
    const Icon = TONE_ICON[tone];
    const duration = shortDuration(step.durationMs);
    return (
        <li className={`flex items-start gap-2.5 py-1.5 ${step.depth > 0 ? 'pl-6' : ''}`} data-testid={`cowork-plan-try-step-${step.id}`} data-tone={tone}>
            <span className={`flex-shrink-0 w-5 h-5 inline-flex items-center justify-center ${TONE_INK[tone]}`}>
                <Icon aria-hidden="true" className={`w-3.5 h-3.5 ${tone === 'running' ? 'animate-spin' : ''}`} />
                <span className="sr-only">{t(`cowork_plan.try.tone.${tone}`, TONE_FALLBACK[tone])}</span>
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-[13px] break-words ${tone === 'pending' || tone === 'skipped' ? 'text-[var(--text-tertiary)]' : 'font-medium text-[var(--text-primary)]'}`}>{step.title}</span>
                    {tone === 'held' && (
                        <span className={`${PILL} border-[color-mix(in_srgb,var(--warning)_40%,transparent)] text-[var(--warning-ink)]`}>{t('cowork_plan.try.tone.held', TONE_FALLBACK.held)}</span>
                    )}
                    {tone === 'skipped' && <span className={`${PILL} border-[var(--border-default)] text-[var(--text-tertiary)]`}>{t('cowork_plan.try.tone.skipped', TONE_FALLBACK.skipped)}</span>}
                    {step.depth > 0 && <span className={`${PILL} border-[var(--border-default)] text-[var(--text-tertiary)]`}>{t('cowork_plan.try.per_item', 'Once per item')}</span>}
                    {duration && <span className="ml-auto text-[11.5px] tabular-nums text-[var(--text-tertiary)]">{duration}</span>}
                </div>
                {step.error && <p className="text-[12px] text-[var(--error-ink)]">{step.error}</p>}
                <Preview step={step} t={t} />
            </div>
        </li>
    );
}

/** One line for the whole try-out: at work, how it ended, or why it stopped. */
function tryLine(state: PlanTryState, t: TranslateFn): string {
    if (!state.done) return t('cowork_plan.try.running', 'Trying the plan…');
    const totals = tryTotals(state);
    const nothing = t('cowork_plan.try.nothing_changed', 'Nothing was changed or sent.');
    if (state.error || totals.failed > 0) {
        const reason = state.error || t('cowork_plan.try.step_failed', 'a step failed');
        return `${t('cowork_plan.try.stopped', 'The try-out stopped: {reason}', { reason })} ${nothing}`;
    }
    const counted = t('cowork_plan.try.done', '{ran} of {total} steps ran, {held} held back.', { ran: totals.ran, total: totals.total, held: totals.held });
    return `${counted} ${nothing}`;
}

function TryResult({ state, stale, t }: { state: PlanTryState; stale: boolean; t: TranslateFn }) {
    const failed = state.done && (!!state.error || tryTotals(state).failed > 0);
    const duration = state.done ? shortDuration(state.durationMs) : '';
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-plan-try-result" data-done={state.done ? 'yes' : 'no'}>
            <p role="status" className={`text-[12.5px] ${failed ? 'text-[var(--error-ink)]' : 'text-[var(--text-secondary)]'}`}>
                {tryLine(state, t)}
                {duration && <span className="ml-1.5 tabular-nums text-[var(--text-tertiary)]">{duration}</span>}
            </p>
            {stale && (
                <p className="text-[12px] text-[var(--warning-ink)]" data-testid="cowork-plan-try-stale">
                    {t('cowork_plan.try.stale', 'The plan changed since this try-out. Try it again to see the plan as it is now.')}
                </p>
            )}
            <ol className="flex flex-col">
                {state.steps.map((step) => <TryStepRow key={step.id} step={step} t={t} />)}
            </ol>
        </div>
    );
}

function startLabel(state: PlanTryState | null, starting: boolean, t: TranslateFn): string {
    if (starting) return t('cowork_plan.try.starting', 'Starting…');
    if (!state) return t('cowork_plan.try.start', 'Try it first');
    return state.done ? t('cowork_plan.try.again', 'Try again') : t('cowork_plan.try.trying', 'Trying…');
}

export default function CoworkPlanTry({ t, state, starting = false, stale = false, error = null, onStart }: CoworkPlanTryProps) {
    const busy = tryIsRunning(state, starting);
    return (
        <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-subtle)]" data-testid="cowork-plan-try">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="flex-1 min-w-[220px] flex flex-col gap-0.5">
                    <span className={`${LABEL} inline-flex items-center gap-1.5`}>
                        <FlaskConical aria-hidden="true" className="w-3.5 h-3.5" />
                        {t('cowork_plan.try.heading', 'Try it first')}
                    </span>
                    <span className="text-[12px] text-[var(--text-secondary)]">
                        {t('cowork_plan.try.hint', 'Runs the plan once on your real data. It reads for real; nothing is changed or sent.')}
                    </span>
                </div>
                <button type="button" data-testid="cowork-plan-try-start" className={SECONDARY} disabled={busy} onClick={onStart}>
                    {startLabel(state, starting, t)}
                </button>
            </div>
            {error && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{error}</p>}
            {state && <TryResult state={state} stale={stale} t={t} />}
        </div>
    );
}
