/**
 * The regulatory calendar, ported from the web's shared/RegulatoryCalendar.jsx:
 * in-force dates, phases and transition ends of the frameworks that touch the
 * org, split on TODAY by model/calendarMath.ts.
 *
 *   full     the two most recent past dates with their detail and "n days
 *            ago", older ones behind "Show {n} earlier dates"; a "today ·
 *            {date}" divider; every upcoming date; the "Still uncertain"
 *            footer
 *   compact  the next `limitUpcoming` (3) dates and "{n} more dates ›"
 *
 * Every upcoming row carries its countdown, in warning ink within 90 days.
 * The milestone list is small and bounded (the catalogue's dates), so the
 * rows are mapped inside the caller's scroll view.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useLocale, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, kindColor, Text } from '@/shared/ui';

import type { Milestone } from '../api/calendar';
import { countdown, daysUntil, formatCalDate, resolveNow, splitByToday } from '../model/calendarMath';
import { affectsText, countdownText, detailOfMilestone, labelOfMilestone } from '../model/calendarText';

export interface RegulatoryCalendarProps {
    /** undefined/null while unread (or failed); [] → the empty line. */
    milestones: readonly Milestone[] | null | undefined;
    failed?: boolean;
    variant?: 'full' | 'compact';
    now?: number;
    limitUpcoming?: number;
    onOpenCalendar?: () => void;
    testID?: string;
}

interface RowCtx {
    t: TranslateFn;
    nowMs: number;
    fmt: (m: Milestone) => string;
    styles: ReturnType<typeof makeStyles>;
}

const keyOf = (m: Milestone, i: number) => m.id ?? `${m.framework_id}-${m.date}-${i}`;

function PastRow({ m, recent, ctx }: { m: Milestone; recent: boolean; ctx: RowCtx }) {
    const { t } = ctx;
    const days = Math.abs(daysUntil(m.date, ctx.nowMs) ?? 0);
    const parts = [recent ? detailOfMilestone(m, t) : '', m.relevant === false ? t('compliance.cal_not_relevant', 'not relevant') : ''];
    if (recent) parts.push(t('compliance.cal_days_ago', '{days} days ago', { days }));
    const meta = parts.filter(Boolean).join(' · ');
    return (
        <View style={ctx.styles.row} testID={recent ? 'cal-row-recent' : 'cal-row-past'}>
            <Text variant="caption" tone={recent ? 'secondary' : 'tertiary'} style={ctx.styles.date}>
                {ctx.fmt(m)}
            </Text>
            <View style={ctx.styles.body}>
                <Text variant="caption" tone={recent ? 'primary' : 'tertiary'} weight={recent ? 'semibold' : undefined}>
                    {labelOfMilestone(m, t)}
                </Text>
                {meta ? <Text variant="label" tone="tertiary">{meta}</Text> : null}
            </View>
        </View>
    );
}

function UpcomingRow({ m, ctx }: { m: Milestone; ctx: RowCtx }) {
    const { t } = ctx;
    const cd = countdown(daysUntil(m.date, ctx.nowMs));
    const meta = [detailOfMilestone(m, t), affectsText(m.affects, t)].filter(Boolean);
    if (m.relevant === false) meta.push(t('compliance.cal_not_relevant', 'not relevant'));
    return (
        <View style={ctx.styles.row} testID="cal-row-upcoming">
            <Text variant="caption" weight="semibold" style={ctx.styles.date}>
                {ctx.fmt(m)}
            </Text>
            <View style={ctx.styles.body}>
                <Text variant="caption" weight="medium">{labelOfMilestone(m, t)}</Text>
                <Text variant="label" tone="tertiary">
                    {meta.join(' · ')}
                    {cd && meta.length ? ' · ' : ''}
                    {cd ? (
                        <Text variant="label" tone={cd.soon ? 'warning' : 'tertiary'} weight={cd.soon ? 'medium' : undefined} testID={cd.soon ? 'cal-countdown-soon' : 'cal-countdown'}>
                            {countdownText(cd, t)}
                        </Text>
                    ) : null}
                </Text>
            </View>
        </View>
    );
}

function TodayDivider({ label, styles }: { label: string; styles: ReturnType<typeof makeStyles> }) {
    return (
        <View style={styles.today} testID="cal-today" accessibilityRole="text" accessibilityLabel={label}>
            <View style={styles.todayLine} />
            <Text variant="label" weight="semibold" style={styles.todayText}>
                {label.toUpperCase()}
            </Text>
            <View style={styles.todayLine} />
        </View>
    );
}

function Uncertain({ items, t, styles }: { items: readonly Milestone[]; t: TranslateFn; styles: ReturnType<typeof makeStyles> }) {
    const text = items
        .map((m) => {
            const detail = detailOfMilestone(m, t);
            const expected = m.expected ? ` · ${t('compliance.cal_expected', 'expected {when}', { when: m.expected })}` : '';
            return `${labelOfMilestone(m, t)}${detail ? ` — ${detail}` : ''}${expected}`;
        })
        .join(' · ');
    return (
        <View style={styles.uncertain} testID="cal-uncertain">
            <Text variant="label" tone="secondary">
                <Text variant="label" tone="secondary" weight="semibold">{`${t('compliance.cal_uncertain_title', 'Still uncertain')}: `}</Text>
                {text}
            </Text>
        </View>
    );
}

function Earlier({ past, ctx }: { past: readonly Milestone[]; ctx: RowCtx }) {
    const [open, setOpen] = useState(false);
    const { t } = ctx;
    return (
        <>
            <View style={ctx.styles.toggle}>
                <Button
                    variant="ghost"
                    size="sm"
                    iconName={open ? undefined : 'ChevronDown'}
                    label={open ? t('compliance.ovw_show_fewer', 'Show fewer') : t('compliance.cal_show_earlier', 'Show {n} earlier dates', { n: past.length })}
                    onPress={() => setOpen((v) => !v)}
                    testID="cal-earlier-toggle"
                />
            </View>
            {open ? past.map((m, i) => <PastRow key={keyOf(m, i)} m={m} recent={false} ctx={ctx} />) : null}
        </>
    );
}

function StateLine({ text, testID }: { text: string; testID: string }) {
    return (
        <Text variant="caption" tone="tertiary" testID={testID}>
            {text}
        </Text>
    );
}

type Split = ReturnType<typeof splitByToday<Milestone>>;

/** Past (two recent, older behind the toggle), the today divider, every upcoming date, the uncertain footer. */
function Full({ split, ctx, todayLabel }: { split: Split; ctx: RowCtx; todayLabel: string }) {
    const { past, upcoming, uncertain } = split;
    const recentFrom = Math.max(0, past.length - 2);
    return (
        <>
            {recentFrom > 0 ? <Earlier past={past.slice(0, recentFrom)} ctx={ctx} /> : null}
            {past.slice(recentFrom).map((m, i) => (
                <PastRow key={keyOf(m, i)} m={m} recent ctx={ctx} />
            ))}
            <TodayDivider label={todayLabel} styles={ctx.styles} />
            {upcoming.map((m, i) => (
                <UpcomingRow key={keyOf(m, i)} m={m} ctx={ctx} />
            ))}
            {upcoming.length === 0 ? <StateLine testID="cal-empty" text={ctx.t('compliance.cal_empty', 'No upcoming dates')} /> : null}
            {uncertain.length > 0 ? <Uncertain items={uncertain} t={ctx.t} styles={ctx.styles} /> : null}
        </>
    );
}

/** The next `limit` dates and "{n} more dates ›". */
function Compact({ upcoming, ctx, limit, onOpenCalendar }: { upcoming: readonly Milestone[]; ctx: RowCtx; limit: number; onOpenCalendar?: () => void }) {
    const shown = upcoming.slice(0, limit);
    const hidden = upcoming.length - shown.length;
    return (
        <>
            {shown.map((m, i) => (
                <UpcomingRow key={keyOf(m, i)} m={m} ctx={ctx} />
            ))}
            {shown.length === 0 ? <StateLine testID="cal-empty" text={ctx.t('compliance.cal_empty', 'No upcoming dates')} /> : null}
            {hidden > 0 && onOpenCalendar ? (
                <View style={ctx.styles.more}>
                    <Button variant="ghost" size="sm" label={`${ctx.t('compliance.cal_more', '{n} more dates', { n: hidden })} ›`} onPress={onOpenCalendar} testID="cal-more" />
                </View>
            ) : null}
        </>
    );
}

export function RegulatoryCalendar({ milestones, failed = false, variant = 'full', now, limitUpcoming, onOpenCalendar, testID = 'reg-calendar' }: RegulatoryCalendarProps) {
    const t = useTranslation();
    const { locale } = useLocale();
    const styles = useThemedStyles(makeStyles);
    if (!milestones) {
        return failed ? (
            <StateLine testID={`${testID}-failed`} text={t('compliance.fw_calendar_failed', 'The regulatory calendar could not be read.')} />
        ) : (
            <StateLine testID={`${testID}-loading`} text={t('compliance.ovw_calendar_loading', 'Reading the calendar…')} />
        );
    }
    const nowMs = resolveNow(now);
    const compact = variant === 'compact';
    const split = splitByToday(milestones, nowMs);
    const ctx: RowCtx = { t, nowMs, styles, fmt: (m) => formatCalDate(m.date, { locale, now: nowMs, year: compact ? 'auto' : 'always' }) };
    return (
        <View testID={testID}>
            {compact ? (
                <Compact upcoming={split.upcoming} ctx={ctx} limit={limitUpcoming ?? 3} onOpenCalendar={onOpenCalendar} />
            ) : (
                <Full split={split} ctx={ctx} todayLabel={t('compliance.cal_today', 'today · {date}', { date: formatCalDate(nowMs, { locale, now: nowMs }) })} />
            )}
        </View>
    );
}

const makeStyles = (theme: Theme) => {
    const accent = kindColor(theme, 'compliance');
    return StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing[2.5], paddingVertical: theme.spacing[1.5] },
        date: { width: 92 },
        body: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
        today: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
        todayLine: { flex: 1, height: 2, backgroundColor: accent },
        todayText: { color: accent, letterSpacing: 0.6 },
        uncertain: { marginTop: theme.spacing[2], paddingHorizontal: theme.spacing[2.5], paddingVertical: theme.spacing[2], borderRadius: theme.radii.md, backgroundColor: theme.colors.bgSecondary },
        toggle: { alignSelf: 'flex-start' },
        more: { alignSelf: 'flex-end' },
    });
};
