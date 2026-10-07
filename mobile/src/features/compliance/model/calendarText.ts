/**
 * The words of a calendar row, from the web's shared/RegulatoryCalendar.jsx
 * (labelOf, detailOf, affectsText, countdownText). Labels arrive as keys;
 * a ready `label` / `detail` string wins.
 */

import type { TranslateFn } from '@/core/i18n';

import type { Countdown } from './calendarMath';

export interface MilestoneWords {
    id?: string | null;
    label?: string | null;
    label_key?: string | null;
    detail?: string | null;
    detail_key?: string | null;
}

export function labelOfMilestone(m: MilestoneWords, t: TranslateFn): string {
    if (m.label) return m.label;
    return m.label_key ? t(m.label_key, m.id ?? '') : (m.id ?? '');
}

export function detailOfMilestone(m: MilestoneWords, t: TranslateFn): string {
    if (m.detail) return m.detail;
    return m.detail_key ? t(m.detail_key, '') : '';
}

const AFFECTS: readonly [string, string][] = [
    ['automations', '{n} automations'],
    ['agents', '{n} agents'],
    ['webpages', '{n} webpages'],
    ['forms', '{n} forms'],
];

/** "affects 3 automations, 2 agents"; '' when nothing is touched. */
export function affectsText(affects: Record<string, number> | null | undefined, t: TranslateFn): string {
    if (!affects) return '';
    const parts = AFFECTS.filter(([k]) => (affects[k] ?? 0) > 0).map(([k, en]) => t(`compliance.cal_affects_${k}`, en, { n: affects[k] ?? 0 }));
    return parts.length ? t('compliance.cal_affects', 'affects {list}', { list: parts.join(', ') }) : '';
}

export function countdownText(cd: Countdown | null, t: TranslateFn): string {
    if (!cd) return '';
    if (cd.unit === 'today') return t('compliance.cal_due_today', 'today');
    if (cd.unit === 'days') return t('compliance.cal_in_days', 'in {days} days', { days: cd.n });
    return t('compliance.cal_in_months', 'in {months} months', { months: cd.n });
}
