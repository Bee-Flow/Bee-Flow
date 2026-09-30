/**
 * "Try again if this step fails" as pure data — the rules of the web's
 * RetrySection (collectionEditors.jsx), pinned by retry.lockstep.test.ts.
 *
 * Two CLOSED lists, not two number fields: `retry` has no validator, so what
 * this row writes is what the runner sleeps on, and a retry's sleep does not
 * re-arm the run deadline — a typed `backoffMs: 300000` parks the run until
 * the 5-minute budget kills it. A stored value off the list is shown as its
 * own choice rather than snapped to a neighbour.
 */

import { translate as t } from '@/core/i18n';

/** The try-again counts offered, as extra attempts after the first. */
export const RETRY_TRY_COUNTS: readonly number[] = [1, 2, 3, 5];
/** The waits offered, in the runner's unit (ms). */
export const RETRY_WAIT_MS: readonly number[] = [0, 2000, 5000, 15000, 30000, 60_000];
/** Two extra tries, five seconds apart — a rate limit's usual shape. */
export const RETRY_DEFAULT = { max: 2, backoffMs: 5000 } as const;
/** Half the default run budget (5 min) spent waiting. */
export const RETRY_LONG_WAIT_MS = 150_000;

export interface Retry {
    max: number;
    backoffMs: number;
}

/** The stored retry when it is ON (`max: 0` is the runner's own "off"). */
export function activeRetry(value: unknown): Retry | null {
    const r = value as Partial<Retry> | null | undefined;
    if (!r || !(Number(r.max) > 0)) return null;
    return { max: Number(r.max) || 1, backoffMs: Number(r.backoffMs) || 0 };
}

/** The offered values, plus the stored one when it is not among them. */
export function retryChoices(offered: readonly number[], stored: number): number[] {
    return offered.includes(stored) ? offered.slice() : [...offered, stored].sort((a, b) => a - b);
}

export function retryTriesLabel(n: number): string {
    if (n === 1) return t('mobile.flow.retry.once', 'Once');
    if (n === 2) return t('mobile.flow.retry.twice', 'Twice');
    return t('mobile.flow.retry.times', '{n} times', { n });
}

export function retryWaitLabel(ms: number): string {
    if (!ms) return t('mobile.flow.retry.straight_away', 'Straight away');
    const s = Math.round(ms / 100) / 10;
    if (s >= 60 && s % 60 === 0) {
        const m = s / 60;
        return m === 1 ? t('mobile.flow.retry.after_minute', 'After 1 minute') : t('mobile.flow.retry.after_minutes', 'After {n} minutes', { n: m });
    }
    return s === 1 ? t('mobile.flow.retry.after_second', 'After 1 second') : t('mobile.flow.retry.after_seconds', 'After {n} seconds', { n: s });
}

/**
 * How many rows the waiting is paid on: one, or — with "Run once per item"
 * and a list set — the runner's per-row cap, since each row retries alone.
 */
export function retryRowCap(forEach: unknown): number {
    const fe = forEach as { overRef?: unknown; maxIterations?: unknown } | null | undefined;
    if (!fe || !fe.overRef) return 1;
    return Math.min(Number(fe.maxIterations) || 100, 1000);
}

/** The worst-case waiting in seconds, and whether it could end the run first. */
export function retryWaitTotal(retry: Retry, rowCap: number): { seconds: number; long: boolean } | null {
    const ms = retry.max * retry.backoffMs * rowCap;
    if (ms <= 0) return null;
    return { seconds: Math.round(ms / 1000), long: ms >= RETRY_LONG_WAIT_MS };
}
