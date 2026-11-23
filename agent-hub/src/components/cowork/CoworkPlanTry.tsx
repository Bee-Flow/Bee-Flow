/**
 * "Try it first": the try-out of a plan, inside the plan card. One button runs the plan once on the owner's real
 * data; what only reads runs for real, and everything that would change or send something is held back. The list
 * shows each step as it goes, with what it got or what it WOULD have changed or sent (./CoworkPlanSteps.tsx).
 *
 * Presentation only: the try-out comes in as props (./CoworkPlanPanel.tsx starts it and follows it).
 */
import { FlaskConical } from 'lucide-react';
import CoworkPlanSteps from './CoworkPlanSteps';
import { shortDuration, tryIsRunning, tryTotals } from './coworkPlanTryModel';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { PlanTryState } from '../../api/coworkPlan.types';

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

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const SECONDARY = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

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
            <CoworkPlanSteps steps={state.steps} t={t} />
        </div>
    );
}

function startLabel(state: PlanTryState | null, starting: boolean, t: TranslateFn): string {
    if (starting) return t('cowork_plan.try.starting', 'Starting…');
    if (!state) return t('cowork_plan.try.start', 'Try it first');
    return state.done ? t('cowork_plan.try.again', 'Try again') : t('cowork_plan.try.trying', 'Trying…');
}

export default function CoworkPlanTry({ t, state, starting = false, stale = false, error = null, onStart }: CoworkPlanTryProps) {
    // A failed read ends the following: the button comes back, whatever the last state said.
    const busy = tryIsRunning(state, starting) && !error;
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
