import React, { useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { countdown, daysUntil, formatCalDate, resolveNow, splitByToday } from './calendarMath';

/**
 * RegulatoryCalendar — in-force dates, phases and transition ends of the
 * frameworks that touch this org, split on TODAY (Compliance Center
 * redesign, Sep 2026; artboard 1e right column = `variant="full"`, the 1a
 * "Komende data" card = `variant="compact"`).
 *
 * The calendar lives in the product, not only in a document: the server
 * (`GET /calendar`) knows the dates and which frameworks are relevant, the
 * client knows what day it is. `calendarMath.splitByToday` does the split;
 * this component only lays it out:
 *
 *   past rows      the two most RECENT past dates, with secondary text, a
 *                  bold title and "n days ago": what just came into force is
 *                  still news. Older dates are greyed one-liners, oldest
 *                  first, behind one "Show {n} earlier dates" toggle — history
 *                  one click away instead of a screen of it above today
 *   today divider  two 2px lines in the kind colour around "today · 14 sep
 *                  2026" (full variant only; the compact card's header
 *                  already says which day it is)
 *   upcoming rows  bold tabular date, 500 title, an 11px meta line: detail ·
 *                  "affects 3 automations" · "in 79 days" — the countdown in
 *                  warning ink when it is 90 days or nearer, in months beyond.
 *                  The compact card keeps the meta to one line (full text in
 *                  the title) and the countdown always visible beside it
 *   uncertain      a `--bg-secondary` footer box for items without a date
 *                  (Digital Omnibus, the Dutch AI implementation act)
 *
 * Labels come from the server as KEYS (`label_key` / `detail_key`, contract
 * §1.2) so the Languages panel can reach them; a ready `label`/`detail`
 * string wins when the caller has one (demo fixtures, custom frameworks).
 *
 * Props
 *   milestones     GET /calendar rows; undefined/null → renders nothing (the
 *                  caller owns the loading and error states), [] → empty line
 *   now            ms or Date; injectable for tests
 *   variant        'full' (80px date column, past + divider + footer) |
 *                  'compact' (78px column, upcoming only)
 *   limitUpcoming  cap on upcoming rows (compact defaults to 3)
 *   onOpenCalendar compact: when more dates exist than shown, a "n more dates
 *                  ›" footer link calls it
 *   t / locale     translation function and reading locale; default to
 *                  useTranslation() so callers may omit them
 */
export default function RegulatoryCalendar({
    milestones, now, variant = 'full', limitUpcoming, onOpenCalendar, t: tProp, locale: localeProp,
    className = '', testId = 'reg-calendar',
}) {
    const hook = useTranslation();
    const t = tProp ?? hook.t;
    const locale = localeProp ?? hook.resolvedLocale ?? 'en';
    const nowMs = useMemo(() => resolveNow(now), [now]);
    const [showEarlier, setShowEarlier] = useState(false);
    const earlierId = useId();

    const { past, upcoming, uncertain } = useMemo(() => splitByToday(milestones, nowMs), [milestones, nowMs]);

    if (milestones === null || milestones === undefined) return null;

    const compact = variant === 'compact';
    const limit = limitUpcoming ?? (compact ? 3 : Infinity);
    const shown = upcoming.slice(0, limit);
    const hidden = upcoming.length - shown.length;
    const cols = compact ? '78px 1fr' : '80px 1fr';
    const rowClass = compact
        ? 'grid gap-[10px] py-2 border-t border-[var(--border-default)] text-[12px]'
        : 'grid gap-[10px] py-[6px] text-[12px]';
    const yearMode = compact ? 'auto' : 'always';
    const fmtDate = (m) => formatCalDate(m.date, { locale, now: nowMs, year: yearMode });
    const labelOf = (m) => m.label ?? (m.label_key ? t(m.label_key, m.id ?? '') : (m.id ?? ''));
    const detailOf = (m) => m.detail ?? (m.detail_key ? t(m.detail_key, '') : '');
    const recentFrom = Math.max(0, past.length - 2);
    const earlier = recentFrom;
    const pastProps = { t, cols, rowClass, nowMs, fmtDate, labelOf, detailOf };

    return (
        <div className={`flex flex-col ${className}`} data-testid={testId} data-variant={variant}>
            {!compact && earlier > 0 && (
                <button
                    type="button"
                    onClick={() => setShowEarlier(v => !v)}
                    aria-expanded={showEarlier}
                    aria-controls={earlierId}
                    data-testid="cal-earlier-toggle"
                    className="-mx-1 mb-1 inline-flex items-center gap-1 self-start rounded px-1 py-0.5 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent border-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                    {showEarlier
                        ? t('compliance.ovw_show_fewer', 'Show fewer')
                        : t('compliance.cal_show_earlier', 'Show {n} earlier dates', { n: earlier })}
                    <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${showEarlier ? 'rotate-180' : ''}`} />
                </button>
            )}
            {!compact && showEarlier && earlier > 0 && (
                <div id={earlierId} className="flex flex-col">
                    {past.slice(0, recentFrom).map(m => (
                        <PastRow key={m.id ?? `${m.framework_id}-${m.date}`} m={m} recent={false} {...pastProps} />
                    ))}
                </div>
            )}
            {!compact && past.slice(recentFrom).map(m => (
                <PastRow key={m.id ?? `${m.framework_id}-${m.date}`} m={m} recent {...pastProps} />
            ))}

            {!compact && (
                <div className="flex items-center gap-2 py-2" data-testid="cal-today" role="separator"
                    aria-label={t('compliance.cal_today', 'today · {date}', { date: formatCalDate(nowMs, { locale, now: nowMs, year: 'always' }) })}>
                    <span className="flex-1 h-[2px] bg-[var(--kind-compliance)]" aria-hidden="true" />
                    <span className="text-[10px] font-semibold uppercase tracking-[.06em] whitespace-nowrap text-[var(--kind-compliance)]">
                        {t('compliance.cal_today', 'today · {date}', { date: formatCalDate(nowMs, { locale, now: nowMs, year: 'always' }) })}
                    </span>
                    <span className="flex-1 h-[2px] bg-[var(--kind-compliance)]" aria-hidden="true" />
                </div>
            )}

            {shown.map((m) => (
                <UpcomingRow
                    key={m.id ?? `${m.framework_id}-${m.date}`}
                    m={m} t={t} cols={cols} rowClass={rowClass} compact={compact}
                    date={fmtDate(m)} days={daysUntil(m.date, nowMs)} label={labelOf(m)} detail={detailOf(m)}
                />
            ))}

            {shown.length === 0 && (
                <div className={`${rowClass} text-[var(--text-tertiary)]`} style={{ gridTemplateColumns: '1fr' }} data-testid="cal-empty">
                    {t('compliance.cal_empty', 'No upcoming dates')}
                </div>
            )}

            {compact && hidden > 0 && onOpenCalendar && (
                <button
                    type="button"
                    onClick={onOpenCalendar}
                    data-testid="cal-more"
                    className="mt-auto inline-flex items-center gap-1 self-end pt-2 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent border-0 p-0 cursor-pointer"
                >
                    {t('compliance.cal_more', '{n} more dates', { n: hidden })}
                    <ChevronRight size={12} aria-hidden="true" />
                </button>
            )}

            {!compact && uncertain.length > 0 && (
                <div
                    className="mt-2 px-[10px] py-2 rounded-lg bg-[var(--bg-secondary)] text-[11px] leading-[15px] text-[var(--text-secondary)]"
                    data-testid="cal-uncertain"
                >
                    <b className="font-semibold">{t('compliance.cal_uncertain_title', 'Still uncertain')}:</b>{' '}
                    {uncertain.map((m, i) => {
                        const detail = detailOf(m);
                        return (
                            <React.Fragment key={m.id ?? i}>
                                {i > 0 ? ' · ' : null}
                                <span data-testid="cal-uncertain-item">
                                    {labelOf(m)}
                                    {detail ? ` — ${detail}` : ''}
                                    {m.expected ? ` · ${t('compliance.cal_expected', 'expected {when}', { when: m.expected })}` : ''}
                                </span>
                            </React.Fragment>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** "affects 3 automations, 2 agents" from the server's affects counts; '' when nothing is touched. */
function affectsText(affects, t) {
    if (!affects || typeof affects !== 'object') return '';
    const parts = [];
    const n = (k) => Number(affects[k]) || 0;
    if (n('automations') > 0) parts.push(t('compliance.cal_affects_automations', '{n} automations', { n: n('automations') }));
    if (n('agents') > 0) parts.push(t('compliance.cal_affects_agents', '{n} agents', { n: n('agents') }));
    if (n('webpages') > 0) parts.push(t('compliance.cal_affects_webpages', '{n} webpages', { n: n('webpages') }));
    if (n('forms') > 0) parts.push(t('compliance.cal_affects_forms', '{n} forms', { n: n('forms') }));
    return parts.length ? t('compliance.cal_affects', 'affects {list}', { list: parts.join(', ') }) : '';
}

function countdownText(cd, t) {
    if (!cd) return '';
    if (cd.unit === 'today') return t('compliance.cal_due_today', 'today');
    if (cd.unit === 'days') return t('compliance.cal_in_days', 'in {days} days', { days: cd.n });
    return t('compliance.cal_in_months', 'in {months} months', { months: cd.n });
}

/** A past date: greyed one-liner, or — for the two most recent — bold with its detail and "n days ago". */
function PastRow({ m, recent, t, cols, rowClass, nowMs, fmtDate, labelOf, detailOf }) {
    const days = Math.abs(daysUntil(m.date, nowMs));
    const detail = recent ? detailOf(m) : '';
    return (
        <div
            className={`${rowClass} ${recent ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'}`}
            style={{ gridTemplateColumns: cols }}
            data-testid="cal-row"
            data-when={recent ? 'recent' : 'past'}
        >
            <span className="tabular-nums">{fmtDate(m)}</span>
            <span className="min-w-0">
                {recent
                    ? <b className="font-semibold text-[var(--text-primary)]">{labelOf(m)}</b>
                    : labelOf(m)}
                {detail ? <> · {detail}</> : null}
                {m.relevant === false
                    ? <> · <span className="text-[11px]">{t('compliance.cal_not_relevant', 'not relevant')}</span></>
                    : null}
                {recent
                    ? <> · <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.cal_days_ago', '{days} days ago', { days })}</span></>
                    : null}
            </span>
        </div>
    );
}

function UpcomingRow({ m, t, cols, rowClass, compact, date, days, label, detail }) {
    const cd = countdown(days);
    const meta = [detail, affectsText(m.affects, t)].filter(Boolean);
    if (m.relevant === false) meta.push(t('compliance.cal_not_relevant', 'not relevant'));
    const countdownNode = cd ? (
        <span
            data-testid="cal-countdown"
            className={cd.soon ? 'font-medium' : ''}
            style={cd.soon ? { color: 'var(--warning-ink)' } : undefined}
        >
            {countdownText(cd, t)}
        </span>
    ) : null;
    return (
        <div className={rowClass} style={{ gridTemplateColumns: cols }} data-testid="cal-row" data-when="upcoming" data-soon={cd?.soon ? 'true' : 'false'}>
            <span className="font-semibold tabular-nums text-[var(--text-primary)]">{date}</span>
            <div className="min-w-0">
                <div className="font-medium text-[var(--text-primary)]">{label}</div>
                {compact ? (
                    // One line: the meta truncates (full text in the title), the countdown never does.
                    <div className="flex min-w-0 text-[11px] text-[var(--text-tertiary)]" data-testid="cal-meta">
                        {meta.length ? <span className="line-clamp-1 min-w-0" title={meta.join(' · ')}>{meta.join(' · ')}</span> : null}
                        {countdownNode ? <span className="shrink-0 whitespace-nowrap">{meta.length ? '\u00a0· ' : null}{countdownNode}</span> : null}
                    </div>
                ) : (
                    <div className="text-[11px] text-[var(--text-tertiary)]" data-testid="cal-meta">
                        {meta.map((part, i) => <React.Fragment key={i}>{i > 0 ? ' · ' : null}{part}</React.Fragment>)}
                        {countdownNode ? <>{meta.length ? ' · ' : null}{countdownNode}</> : null}
                    </div>
                )}
            </div>
        </div>
    );
}
