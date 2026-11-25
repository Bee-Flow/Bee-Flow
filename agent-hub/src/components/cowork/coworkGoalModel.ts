// How a goal's count reads, in the brief (./CoworkGoal.tsx) and on the list's row (./CoworkRow.tsx): "46 of 49 this
// week", or that nothing was counted yet.

import type { TranslateFn } from '@/hooks/useTranslation';

interface Counted { met: number | null; total: number | null; period: string | null }

/** "46 of 49 this week"; "not measured yet" before a first count. */
export function goalCountText(count: Counted | null | undefined, t: TranslateFn): string {
    if (!count || count.met === null || count.total === null) return t('cowork_goals.not_measured', 'not measured yet');
    const numbers = t('cowork_goals.count', '{met} of {total}', { met: count.met, total: count.total });
    return count.period ? `${numbers} ${count.period}` : numbers;
}
