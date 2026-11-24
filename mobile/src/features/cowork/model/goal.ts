/** How an item's goal reads on the phone: "Goal: every supplier mail answered in two days · 46 of 49". */

import type { TranslateFn } from '@/core/i18n';

import type { CoworkGoalLine } from './types';

export function goalLabel(goal: CoworkGoalLine, t: TranslateFn): string {
    const line = t('cowork_goals.line', 'Goal: {sentence}', { sentence: goal.sentence });
    const count = goal.met !== null && goal.total !== null
        ? t('cowork_goals.count', '{met} of {total}', { met: goal.met, total: goal.total })
        : t('cowork_goals.not_measured', 'not measured yet');
    return `${line} · ${count}`;
}
