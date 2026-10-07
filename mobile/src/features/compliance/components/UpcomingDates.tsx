/**
 * The home's compact "Upcoming dates" card (web: overview/UpcomingDatesCard.jsx):
 * a "today {date}" stamp, the next three milestones, and "{n} more dates ›"
 * and "Calendar ›", both to the calendar page. Its own loading and failed
 * lines; never an empty list for a read that failed.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useLocale, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Icon, Text } from '@/shared/ui';

import { RegulatoryCalendar } from './RegulatoryCalendar';
import { useCalendar } from '../hooks/calendar';
import { formatCalDate, resolveNow } from '../model/calendarMath';
import { pageRoute } from '../model/sections';

export function UpcomingDates({ enabled, now }: { enabled: boolean; now?: number }) {
    const t = useTranslation();
    const { locale } = useLocale();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const calendar = useCalendar(enabled);
    const open = () => router.push(pageRoute('calendar'));
    const milestones = calendar.data?.milestones ?? null;
    return (
        <Card testID="upcoming-dates">
            <View style={styles.header}>
                <Icon name="CalendarClock" size={14} />
                <Text variant="caption" weight="semibold">
                    {t('compliance.ovw_upcoming_title', 'Upcoming dates')}
                </Text>
                <Text variant="label" tone="tertiary" style={styles.stamp} testID="upcoming-dates-today">
                    {t('compliance.cal_today_short', 'today {date}', { date: formatCalDate(resolveNow(now), { locale }) })}
                </Text>
                <Button variant="ghost" size="sm" label={`${t('compliance.ovw_open_calendar', 'Calendar')} ›`} onPress={open} testID="upcoming-dates-open" />
            </View>
            {milestones === null ? (
                <Text variant="caption" tone="tertiary" testID="upcoming-dates-unavailable">
                    {calendar.isError
                        ? t('compliance.ovw_calendar_unavailable', 'Could not read the regulatory calendar right now.')
                        : t('compliance.ovw_calendar_loading', 'Reading the calendar…')}
                </Text>
            ) : (
                <RegulatoryCalendar variant="compact" milestones={milestones} now={now} onOpenCalendar={open} testID="upcoming-dates-calendar" />
            )}
        </Card>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.spacing[2] },
        stamp: { flex: 1 },
    });
