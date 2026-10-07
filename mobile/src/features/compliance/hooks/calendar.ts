/**
 * The regulatory calendar's reads: the whole calendar (GET /calendar), and
 * the next dated milestone of one framework for a hub row ("next: {date} ·
 * {title}"). Both share one query, so the page, the card and the row agree.
 */

import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '@/core/i18n';

import { calendarKeys, getCalendar } from '../api/calendar';
import { splitByToday } from '../model/calendarMath';
import { labelOfMilestone } from '../model/calendarText';

export const useCalendar = (enabled: boolean, all = false) =>
    useQuery({
        queryKey: calendarKeys.calendar(all),
        queryFn: ({ signal }) => getCalendar(all, signal),
        enabled,
    });

/** The framework's nearest milestone today or later, or null (none, or not read yet). */
export function useNextMilestone(frameworkId: string, enabled = true): { date: string; title: string } | null {
    const t = useTranslation();
    const calendar = useCalendar(enabled);
    const own = (calendar.data?.milestones ?? []).filter((m) => m.framework_id === frameworkId);
    const next = splitByToday(own).upcoming[0];
    return next?.date ? { date: next.date, title: labelOfMilestone(next, t) } : null;
}
