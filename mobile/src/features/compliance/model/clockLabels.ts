/**
 * The words of a deadline clock: port of clockLabel and clockRowLabel in
 * agent-hub/src/components/shared/DeadlineClock.jsx (the keys are pinned
 * textually by deadlineMath.test.ts). `n === 1` reads the `_one` keys.
 */

import type { TranslateFn } from '@/core/i18n';

import type { ClockResult } from './deadlineMath';

type Clock = Pick<ClockResult, 'state' | 'unit' | 'value' | 'completedInDays'>;

function doneLabel(t: TranslateFn, completedInDays: number | null): string {
    if (completedInDays !== null && completedInDays !== undefined) {
        return completedInDays === 1
            ? t('compliance.clock_done_in_days_one', 'completed in 1 day', { days: 1 })
            : t('compliance.clock_done_in_days', 'completed in {days} days', { days: completedInDays });
    }
    return t('compliance.clock_done', 'completed');
}

function overdueLabel(t: TranslateFn, unit: Clock['unit'], n: number): string {
    if (unit === 'hours') {
        return n === 1
            ? t('compliance.clock_hours_overdue_one', 'overdue by 1 hour', { hours: 1 })
            : t('compliance.clock_hours_overdue', 'overdue by {hours} hours', { hours: n });
    }
    return n === 1
        ? t('compliance.clock_days_overdue_one', 'overdue by 1 day', { days: 1 })
        : t('compliance.clock_days_overdue', 'overdue by {days} days', { days: n });
}

/** The full sentence for a resolved clock. */
export function clockLabel(t: TranslateFn, { state, unit, value, completedInDays }: Clock, done?: string): string {
    if (state === 'none') return t('compliance.clock_none', 'no open deadline');
    if (state === 'done') return done ?? doneLabel(t, completedInDays);
    const n = value ?? 0;
    if (state === 'overdue') return overdueLabel(t, unit, n);
    if (unit === 'hours') {
        return n === 1 ? t('compliance.clock_hours_left_one', '1 hour left', { hours: 1 }) : t('compliance.clock_hours_left', '{hours} hours left', { hours: n });
    }
    return n === 1 ? t('compliance.clock_days_left_one', '1 day left', { days: 1 }) : t('compliance.clock_days_left', '{days} days left', { days: n });
}

/** The compact form for an OPEN clock: "3 d left", "31 d overdue", "5 h left". */
export function clockRowLabel(t: TranslateFn, { state, unit, value }: Clock): string {
    const n = value ?? 0;
    if (state === 'overdue') {
        return unit === 'hours'
            ? t('compliance.clock_row_hours_overdue', '{hours} h overdue', { hours: n })
            : t('compliance.clock_row_days_overdue', '{days} d overdue', { days: n });
    }
    return unit === 'hours'
        ? t('compliance.clock_row_hours_left', '{hours} h left', { hours: n })
        : t('compliance.clock_row_days_left', '{days} d left', { days: n });
}
