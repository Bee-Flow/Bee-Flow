import React from 'react';
import { CalendarDays, ArrowUpRight } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import RegulatoryCalendar from '../../shared/RegulatoryCalendar';
import { formatCalDate } from '../../shared/calendarMath';

/**
 * UpcomingDatesCard — the Overview's "Upcoming dates" card (artboard 1a, C6).
 * A thin frame around `RegulatoryCalendar variant="compact"`: the calendar
 * atom owns the rows, the countdown and the "{n} more dates ↗" button; this
 * card owns the head, the today stamp and the loading/failed states (rule 6 —
 * the atom renders nothing for `milestones == null`, the page says why).
 *
 *   milestones       GET /calendar rows | null (null = not loaded / failed)
 *   failed           the read failed → its own line, never an empty list
 *   limitUpcoming    rows shown (default 3)
 *   onOpenCalendar() "Calendar ↗" — the page navigates to frameworks › calendar
 */
export default function UpcomingDatesCard({
    milestones = null, failed = false, limitUpcoming = 3, onOpenCalendar,
    now = null, className = '', testId = 'upcoming-dates',
}) {
    const { t, resolvedLocale, locale } = useTranslation();
    const lang = resolvedLocale || locale || 'en';
    const today = formatCalDate(now ? new Date(now) : new Date(), { locale: lang, year: 'always' });

    return (
        <section
            className={`flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5 ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
            aria-label={t('compliance.ovw_upcoming_title', 'Upcoming dates')}
        >
            <header className="flex flex-wrap items-center gap-2">
                <CalendarDays size={14} className="text-[var(--text-secondary)]" aria-hidden />
                <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('compliance.ovw_upcoming_title', 'Upcoming dates')}
                </h3>
                <span className="text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-today`}>
                    {t('compliance.cal_today_short', 'today {date}', { date: today })}
                </span>
                {onOpenCalendar ? (
                    <button
                        type="button"
                        onClick={onOpenCalendar}
                        className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        data-testid={`${testId}-open`}
                    >
                        {t('compliance.ovw_open_calendar', 'Calendar')} <ArrowUpRight size={11} aria-hidden />
                    </button>
                ) : null}
            </header>

            {milestones === null ? (
                <p className="mt-3 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-unavailable`}>
                    {failed
                        ? t('compliance.ovw_calendar_unavailable', 'Could not read the regulatory calendar right now.')
                        : t('compliance.ovw_calendar_loading', 'Reading the calendar…')}
                </p>
            ) : (
                <div className="mt-1">
                    <RegulatoryCalendar
                        variant="compact"
                        milestones={milestones}
                        limitUpcoming={limitUpcoming}
                        onOpenCalendar={onOpenCalendar}
                        now={now || undefined}
                        testId={`${testId}-calendar`}
                    />
                </div>
            )}
        </section>
    );
}
