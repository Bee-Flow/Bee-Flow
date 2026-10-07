/**
 * A framework's phases as a vertical stepper (web shared/TimelinePhases.jsx,
 * its layout below 640px): one row per phase by date, with a "today" step
 * after the last phase not later than today. Markers: done = ink disc with
 * a check, missed = error disc with a cross, upcoming = warning ring,
 * future = border ring. The state is the caller's word (model/timeline.ts).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useLocale, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, kindColor, Text } from '@/shared/ui';

import { formatCalDate } from '../model/calendarMath';
import { stepperOf, type Phase, type PhaseState } from '../model/timeline';

type Styles = ReturnType<typeof makeStyles>;

function Marker({ state, styles }: { state: PhaseState; styles: Styles }) {
    if (state === 'done' || state === 'missed') {
        return (
            <View style={[styles.marker, state === 'done' ? styles.done : styles.missed]}>
                <Icon name={state === 'done' ? 'Check' : 'X'} size={12} color={styles.glyph.color} />
            </View>
        );
    }
    return <View style={[styles.marker, state === 'upcoming' ? styles.upcoming : styles.future]} />;
}

function Step({ phase, date, days, styles }: { phase: Phase; date: string; days: string | null; styles: Styles }) {
    return (
        <View style={styles.step} testID={`timeline-step-${phase.state}`}>
            <Marker state={phase.state} styles={styles} />
            <View style={styles.text}>
                <Text variant="caption" weight="semibold">
                    {phase.title}
                </Text>
                {phase.subtitle ? (
                    <Text variant="label" tone="secondary">
                        {phase.subtitle}
                    </Text>
                ) : null}
                <Text variant="label" tone="tertiary">
                    {date}
                    {days ? ' · ' : ''}
                    {days ? (
                        <Text variant="label" tone="warning" weight="medium">
                            {days}
                        </Text>
                    ) : null}
                </Text>
            </View>
        </View>
    );
}

function TodayStep({ label, styles }: { label: string; styles: Styles }) {
    return (
        <View style={styles.today} testID="timeline-step-today">
            <View style={styles.todayLine} />
            <Text variant="label" weight="semibold" style={styles.todayText}>
                {label.toUpperCase()}
            </Text>
            <View style={styles.todayLine} />
        </View>
    );
}

export function TimelineStepper({ phases, now }: { phases: readonly Phase[]; now?: number }) {
    const t = useTranslation();
    const { locale } = useLocale();
    const styles = useThemedStyles(makeStyles);
    const { items, todayIndex } = stepperOf(phases, now);
    const today = <TodayStep key="today" label={t('compliance.tl_today', 'today')} styles={styles} />;
    return (
        <View testID="timeline-stepper">
            {items.map((p, i) => (
                <React.Fragment key={`${p.date}-${i}`}>
                    {i === todayIndex ? today : null}
                    <Step
                        phase={p}
                        date={formatCalDate(p.date, { locale })}
                        days={typeof p.daysLeft === 'number' ? t('compliance.tl_days_left', '{days} d', { days: p.daysLeft }) : null}
                        styles={styles}
                    />
                </React.Fragment>
            ))}
            {todayIndex === items.length ? today : null}
        </View>
    );
}

const MARKER = 20;

const makeStyles = (theme: Theme) => {
    const accent = kindColor(theme, 'compliance');
    const ring = { backgroundColor: theme.colors.bgCard, borderWidth: 2 };
    return StyleSheet.create({
        step: { flexDirection: 'row', gap: theme.spacing[3], paddingVertical: theme.spacing[2] },
        text: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
        marker: { width: MARKER, height: MARKER, borderRadius: MARKER / 2, alignItems: 'center', justifyContent: 'center' },
        done: { backgroundColor: theme.colors.textPrimary },
        missed: { backgroundColor: theme.colors.error },
        upcoming: { ...ring, borderColor: theme.colors.warning },
        future: { ...ring, borderColor: theme.colors.borderDefault },
        glyph: { color: theme.colors.bgCard },
        today: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingVertical: theme.spacing[1.5] },
        todayLine: { flex: 1, height: 2, backgroundColor: accent },
        todayText: { color: accent, letterSpacing: 0.6 },
    });
};
