/**
 * What the try-out of a plan says, worked out from what the server sent. Pure: no fetching, no React.
 */
import { formatDuration } from './coworkFormat';
import type { PlanTryState, PlanTryStep } from '../../api/coworkPlan.types';

/**
 * How a step of a try-out went:
 *   pending   the try-out has not come to it yet
 *   running   it is at work now
 *   ok        it ran for real (a step that only reads)
 *   held      it ran, and what it would have changed or sent was held back
 *   failed    it stopped with an error
 *   skipped   the try-out ended without it (a branch that was not taken, or a step after a failure)
 */
export type TryTone = 'pending' | 'running' | 'ok' | 'held' | 'failed' | 'skipped';

const BY_STATUS: Record<string, TryTone> = {
    pending: 'pending', queued: 'pending', running: 'running',
    error: 'failed', handled_error: 'failed',
    skipped: 'skipped', not_reached: 'skipped', cancelled: 'skipped',
};

export function tryToneOf(step: Pick<PlanTryStep, 'status' | 'held'>): TryTone {
    const known = BY_STATUS[step.status];
    if (known) return known;
    return step.held ? 'held' : 'ok';
}

/** How many steps ran, how many of those were held back, and how many failed. */
export function tryTotals(state: Pick<PlanTryState, 'steps'>): { total: number; ran: number; held: number; failed: number } {
    const out = { total: state.steps.length, ran: 0, held: 0, failed: 0 };
    for (const step of state.steps) {
        const tone = tryToneOf(step);
        if (tone === 'ok' || tone === 'held') out.ran += 1;
        if (tone === 'held') out.held += 1;
        if (tone === 'failed') out.failed += 1;
    }
    return out;
}

const oneDecimal = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * A step's time: "0.4 s" and "12.3 s" under a minute, minutes and seconds from there, and "<0.1 s" for a step that
 * took next to nothing (a filter is not "0.0 s": it ran). Nothing when the time was not measured.
 */
export function shortDuration(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return '';
    const tenths = Math.round(Math.max(0, ms) / 100);
    if (tenths >= 600) return formatDuration(ms);
    return tenths === 0 ? `<${oneDecimal(0.1)} s` : `${oneDecimal(tenths / 10)} s`;
}

/** A try-out that is still at work: started, and not over. */
export function tryIsRunning(state: PlanTryState | null, starting: boolean): boolean {
    return starting || (state !== null && !state.done);
}
